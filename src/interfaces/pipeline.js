/**
 * pipeline.js — offline pipeline jobs (stage → curate → tag → push).
 *
 * The engine always stages (JSONL in stagedDir). The pipeline then moves rows
 * through curation (manual delete), LLM tagging, and push-to-storage. `push` is
 * fully wired; `tag` runs through the tagging adapter against the configured
 * endpoint (local Ollama on the PC, or a remote/cloud endpoint on the Pi).
 */
import { getConfig } from "../config.js";
import { readStaged, writeStagedSource, groupBySource } from "../core/staged.js";
import { pushStagedToStorage } from "../core/sync.js";
import { detectModels, tag, loadText } from "../adapters/tagging/index.js";
import { getCategories } from "../adapters/categories/index.js";

export function pipelineStatus() {
  return {
    staged: readStaged().length,
    jobs: [
      { key: "curate", label: "Curation (delete before tagging)", status: "ready" },
      { key: "tag", label: "LLM tag", status: "idle" },
      { key: "push", label: "Push to storage", status: "idle" },
    ],
    note: "Tagging uses the configured tagging.providers endpoint (no local model loading).",
  };
}

/** Map a model's {category, subcategory} string ids onto the schema values. */
function resolveIds({ category, subcategory }) {
  const cats = getCategories();
  const cat = cats?.categories?.find((c) => c.id === category || c.label === category);
  const sub = cats?.subcategories?.find((s) => s.id === subcategory || s.label === subcategory);
  return {
    category_id: cat ? (cat.externalId ?? cat.id) : null,
    subcategory_id: sub ? (sub.externalId ?? sub.id) : null,
  };
}

async function runTag() {
  const cfg = getConfig().tagging || {};
  const providers = cfg.providers || [];
  if (!providers.length) throw new Error("No tagging.providers configured.");
  const provider = providers.find((p) => p.id === "ollama") ?? providers[0];
  const model = cfg.model ?? (await detectModels(providers))[0]?.id;
  if (!model) throw new Error("No tagging model configured or detected.");

  const prompt = loadText(cfg.promptFile) || "";
  const cats = getCategories();
  const rawTags = JSON.parse(loadText(cfg.vocabFile) || "[]");
  const tagList = Array.isArray(rawTags) ? rawTags : (rawTags.tags ?? []);
  const vocab = {
    categories: (cats?.categories ?? []).map((c) => ({ id: c.id, label: c.label ?? c.id })),
    tags: tagList,
  };

  const rows = readStaged();
  const tagged = await tag(rows, { provider, model, prompt, vocab, temperature: cfg.temperature ?? 0 });
  for (const [src, rs] of groupBySource(tagged)) {
    writeStagedSource(src, rs.map((r) => ({ ...r, ...resolveIds(r) })));
  }
  return { tagged: tagged.length };
}

export function startPipelineJob(kind) {
  if (kind === "push") {
    const job = { key: "push", alreadyRunning: false };
    pushStagedToStorage()
      .then((r) => console.log("[pipeline] push:", JSON.stringify(r)))
      .catch((e) => console.error("[pipeline] push error:", e.message));
    return job;
  }
  if (kind === "tag") {
    const job = { key: "tag", alreadyRunning: false };
    runTag()
      .then((r) => console.log("[pipeline] tag:", JSON.stringify(r)))
      .catch((e) => console.error("[pipeline] tag error:", e.message));
    return job;
  }
  return null;
}
