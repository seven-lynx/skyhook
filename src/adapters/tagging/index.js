/**
 * tagging/index.js — optional LLM tagging stage.
 *
 * Two concerns:
 *   1. `detectModels(providers)` — probe the configured providers and return the
 *      union of available models (one dropdown in the GUI/TUI).
 *   2. `tag(items, opts)` — run each item through the chosen model using an
 *      editable prompt + controlled vocabulary, returning category/subcategory/
 *      tags.
 *
 * Providers are OpenAI-compatible endpoints, plus Ollama's native chat API and
 * LM Studio's native REST API (for full model management: list all downloaded
 * models, load/unload a model before tagging).
 */
import { readFileSync, existsSync } from "fs";

const DETECT_TIMEOUT_MS = 10000;

/** Fetch with timeout. Returns null on timeout/failure so the caller can accumulate errors. */
async function fetchTimeout(url, opts = {}, timeoutMs = DETECT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a single provider and return { models, error }.
 * - ollama: GET /api/tags → { models: [{ name }] }
 * - lmstudio (or any non-ollama with a localhost baseUrl): use native REST API
 *   GET /api/v1/models → { models: [{ key, display_name, loaded_instances }] }
 *   This lists ALL downloaded models, not just the loaded one.
 * - generic OpenAI: GET /v1/models → { data: [{ id }] }
 */
async function probeProvider(p) {
  if (p.id === "ollama") {
    const res = await fetchTimeout(`${p.baseUrl}/api/tags`);
    if (!res || !res.ok) return { models: [], error: `Ollama unreachable at ${p.baseUrl}` };
    try {
      const data = await res.json();
      const models = (data.models || []).map((m) => ({
        id: m.name, label: m.name, provider: p.id, baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? null, isLoaded: false, instanceId: null,
      }));
      return { models, error: null };
    } catch (e) {
      return { models: [], error: `Ollama response parse error: ${e.message}` };
    }
  }

  // LM Studio native API — strip trailing /v1 from baseUrl to hit native REST.
  const root = p.baseUrl.replace(/\/v1\/?$/, "");
  const nativeUrl = `${root}/api/v1/models`;
  const headers = {};
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;

  const res = await fetchTimeout(nativeUrl, { headers });
  if (res && res.ok) {
    try {
      const data = await res.json();
      const models = (data.models || []).map((m) => {
        const id = m.selected_variant || m.key;
        return {
          id, label: m.display_name || id, provider: p.id,
          baseUrl: p.baseUrl, apiKey: p.apiKey ?? null,
          isLoaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
          instanceId: (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0)
            ? m.loaded_instances[0].id : null,
        };
      });
      return { models, error: null };
    } catch (e) {
      return { models: [], error: `LM Studio response parse error: ${e.message}` };
    }
  }

  // Fallback to OpenAI-compatible /v1/models (currently loaded model only).
  const oaHeaders = {};
  if (p.apiKey) oaHeaders.Authorization = `Bearer ${p.apiKey}`;
  const oaRes = await fetchTimeout(`${p.baseUrl}/models`, { headers: oaHeaders });
  if (oaRes && oaRes.ok) {
    try {
      const data = await oaRes.json();
      const models = (data.data || []).map((m) => ({
        id: m.id, label: m.id, provider: p.id, baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? null, isLoaded: true, instanceId: null,
      }));
      return { models, error: null };
    } catch (e) {
      return { models: [], error: `OpenAI response parse error: ${e.message}` };
    }
  }

  return { models: [], error: `Provider "${p.id}" unreachable at ${p.baseUrl}` };
}

export async function detectModels(providers = []) {
  const all = [];
  const errors = [];
  for (const p of providers) {
    if (!p?.baseUrl) continue;
    const { models, error } = await probeProvider(p);
    all.push(...models);
    if (error) errors.push(error);
  }
  return { models: all, errors: errors.length ? errors : null };
}

/**
 * Ensure a specific model is loaded in LM Studio (or any provider with native
 * REST API). For LM Studio:
 *   1. Check current state via GET /api/v1/models
 *   2. If the requested model is already loaded → no-op
 *   3. If a different model is loaded → unload it first
 *   4. Load the requested model via POST /api/v1/models/load
 *
 * For Ollama/OAI providers this is a no-op (model management happens externally).
 *
 * @returns {{ alreadyLoaded, loaded, loadTimeSeconds?, error? }}
 */
export async function ensureModelLoaded(provider, modelId) {
  if (!provider?.baseUrl || !modelId) {
    return { error: "provider and modelId are required" };
  }
  const root = provider.baseUrl.replace(/\/v1\/?$/, "");
  const authHeaders = { "Content-Type": "application/json" };
  if (provider.apiKey) authHeaders.Authorization = `Bearer ${provider.apiKey}`;

  // Only LM Studio native API supports model load/unload at runtime.
  const listUrl = `${root}/api/v1/models`;
  const listHeaders = {};
  if (provider.apiKey) listHeaders.Authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchTimeout(listUrl, { headers: listHeaders });
  if (!res || !res.ok) {
    return { error: `Cannot reach LM Studio at ${root}` };
  }

  let data;
  try { data = await res.json(); } catch (e) {
    return { error: `LM Studio response parse error: ${e.message}` };
  }

  const models = data.models || [];
  const match = models.find((m) => m.key === modelId || m.selected_variant === modelId);

  if (match && Array.isArray(match.loaded_instances) && match.loaded_instances.length > 0) {
    // Already loaded — nothing to do.
    return { alreadyLoaded: true, instanceId: match.loaded_instances[0].id };
  }

  // Unload any currently loaded model(s).
  for (const m of models) {
    if (Array.isArray(m.loaded_instances)) {
      for (const inst of m.loaded_instances) {
        const unloadUrl = `${root}/api/v1/models/unload`;
        try {
          await fetch(unloadUrl, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ instance_id: inst.id }),
          });
        } catch { /* best effort */ }
      }
    }
  }

  // Load the requested model.
  const loadUrl = `${root}/api/v1/models/load`;
  const loadRes = await fetchTimeout(loadUrl + "?_=" + Date.now(), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: modelId }),
  }, 120000); // model loading can take a while
  if (!loadRes || !loadRes.ok) {
    const body = loadRes ? await loadRes.text().catch(() => "") : "";
    return { error: `Failed to load model "${modelId}": ${loadRes ? loadRes.status : "timeout"} ${body.slice(0, 200)}` };
  }
  try {
    const loadData = await loadRes.json();
    return { loaded: true, instanceId: loadData.instance_id, loadTimeSeconds: loadData.load_time_seconds };
  } catch (e) {
    return { loaded: true, error: `Load succeeded but response parse failed: ${e.message}` };
  }
}

export function loadText(file) {
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function buildPrompt(template, item, vocab = {}) {
  const categories = (vocab.categories ?? [])
    .map((c) => (c.label ? `${c.id} (${c.label})` : c.id))
    .join(", ");
  const tags = (vocab.tags ?? []).join(", ");
  return String(template)
    .replaceAll("{title}", item.title ?? "")
    .replaceAll("{description}", item.description ?? "")
    .replaceAll("{url}", item.url ?? "")
    .replaceAll("{categories}", categories)
    .replaceAll("{tags}", tags);
}

function extractJson(text) {
  const t = String(text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return body.slice(start, end + 1);
}

/**
 * @param {Array<object>} items  canonical rows (url/title/description/…)
 * @param {{ provider, model, prompt, vocab, temperature }} opts
 * @returns {Promise<Array<object>>} items with category/subcategory/tags attached
 */
export async function tag(items, { provider, model, prompt, vocab = {}, temperature = 0 }) {
  if (!provider?.baseUrl || !model) throw new Error("tag() needs a provider.baseUrl and a model");
  const isOllama = provider.id === "ollama" || provider.provider === "ollama";
  const chatUrl = isOllama
    ? `${provider.baseUrl}/api/chat`
    : `${provider.baseUrl}/chat/completions`;

  const out = [];
  for (const item of items) {
    const content = buildPrompt(prompt, item, vocab);
    try {
      const headers = { "Content-Type": "application/json" };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const payload = isOllama
        ? { model, messages: [{ role: "user", content }], stream: false, format: "json", options: { temperature } }
        : { model, messages: [{ role: "user", content }], temperature };
      const res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = isOllama ? data?.message?.content : data?.choices?.[0]?.message?.content;
      const parsed = JSON.parse(extractJson(text));
      out.push({
        ...item,
        category: parsed.category ?? null,
        subcategory: parsed.subcategory ?? null,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      });
    } catch (e) {
      out.push({ ...item, category: null, subcategory: null, tags: [], _tagError: e.message });
    }
  }
  return out;
}
