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
 * Providers are OpenAI-compatible endpoints, plus Ollama's native chat API.
 */
import { readFileSync, existsSync } from "fs";

export async function detectModels(providers = []) {
  const found = [];
  for (const p of providers) {
    if (!p?.baseUrl) continue;
    try {
      if (p.id === "ollama") {
        const res = await fetch(`${p.baseUrl}/api/tags`);
        if (res.ok) {
          const data = await res.json();
          for (const m of data.models || []) {
            found.push({ id: m.name, label: m.name, provider: "ollama", baseUrl: p.baseUrl, apiKey: p.apiKey ?? null });
          }
        }
      } else {
        const headers = {};
        if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
        const res = await fetch(`${p.baseUrl}/models`, { headers });
        if (res.ok) {
          const data = await res.json();
          for (const m of data.data || []) {
            found.push({ id: m.id, label: m.id, provider: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey ?? null });
          }
        }
      }
    } catch {
      /* unreachable provider — skip */
    }
  }
  return found;
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
  const isOllama = provider.provider === "ollama";
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
