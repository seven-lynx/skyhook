/**
 * pipeline.js — config-driven pipeline (stage → curate → tag → push).
 *
 * The engine always stages (JSONL in stagedDir). The pipeline then moves rows
 * through curation (manual delete), LLM tagging, and push-to-storage. `push` is
 * fully wired; `tag` runs through the tagging adapter against the configured
 * endpoint (local Ollama on the PC, or a remote/cloud endpoint on the Pi).
 */
import { spawnSync } from "child_process";
import { statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getConfig } from "../config.js";
import { readStaged, writeStagedSource, groupBySource } from "../core/staged.js";
import { pushStagedToStorage } from "../core/sync.js";
import { detectModels, tag, loadText } from "../adapters/tagging/index.js";
import { getCategories } from "../adapters/categories/index.js";
import { listRunning, runJob } from "../engine/seeder-engine.js";
import { getActiveTaggingProvider } from "../core/settings.js";

export function pipelineConfig() {
  return getConfig().pipeline || {};
}

function fmt(n) {
  return n == null ? "—" : Number(n).toLocaleString();
}

function runStatusScript(script) {
  if (!script) return null;
  try {
    const res = spawnSync(process.execPath, [script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    const json = String(res.stdout || "").trim();
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

function defaultStatus() {
  const rows = readStaged();
  const tagged = rows.filter((r) => r.category_id || r.category || (Array.isArray(r.tags) && r.tags.length)).length;
  const running = listRunning().map((r) => r.source);
  return {
    cards: [
      { id: "staged", value: fmt(rows.length), label: "Cached & ready to tag",
        actions: [{ id: "tag", label: "Start tagging", kind: "tag" }] },
      { id: "tagged", value: fmt(tagged), label: "Tagged & ready to push",
        actions: [{ id: "push", label: "Push to database", kind: "push" }] },
    ],
    jobs: [
      { key: "curate", label: "Curation (delete before tagging)", status: "ready" },
      { key: "tag", label: "LLM tag", status: running.includes("tag") ? "running" : "idle" },
      { key: "push", label: "Push to storage", status: running.includes("push") ? "running" : "idle" },
    ],
    note: "Tagging uses the configured tagging.providers endpoint (no local model loading).",
  };
}

/** Warn when the known-URLs dedup index is old enough to let duplicates back in. */
const KNOWN_URLS_MAX_AGE_DAYS = 7;

function indexAgeCheck(cfg) {
  const path = cfg.knownUrlsDb;
  if (!path) return null;
  try {
    const ageDays = Math.floor((Date.now() - statSync(path).mtimeMs) / 86400000);
    return {
      label: `Known-URLs index (${ageDays}d old)`,
      ok: ageDays <= KNOWN_URLS_MAX_AGE_DAYS,
      detail: ageDays > KNOWN_URLS_MAX_AGE_DAYS
        ? `stale — run \`skyhook pull\` to re-scan the dedup index`
        : undefined,
    };
  } catch {
    return null;
  }
}

export function pipelineStatus() {
  const cfg = pipelineConfig();
  const base = runStatusScript(cfg.status) || defaultStatus();
  const running = listRunning().map((r) => r.source);
  if (Array.isArray(base.jobs)) {
    base.jobs = base.jobs.map((j) => ({ ...j, status: running.includes(j.key) ? "running" : j.status }));
  }
  const stale = indexAgeCheck(cfg);
  if (stale) {
    base.checks = Array.isArray(base.checks) ? base.checks.filter((c) => !/known-urls/i.test(c.label || "")) : [];
    base.checks.push(stale);
  }

  // Surface a retry button whenever the status payload reports failures, so the
  // rows a failed batch stranded are reachable from the GUI and not just a flag.
  const failedMetric = (base.metrics || []).find((m) => /fail/i.test(m.label || ""));
  const failedCount = failedMetric ? Number(String(failedMetric.value).replace(/[^0-9]/g, "")) || 0 : 0;
  if (failedCount > 0 && Array.isArray(base.cards)) {
    for (const card of base.cards) {
      if (card.id !== "tagged") continue;
      card.actions = Array.isArray(card.actions) ? card.actions : [];
      const kind = "tag-retry-failed";
      if (!card.actions.some((a) => (a.kind ?? a.id) === kind)) {
        card.actions.push({
          id: kind,
          label: `Retry ${failedCount.toLocaleString()} failed`,
          kind,
        });
      }
    }
  }

  base.running = running;
  return base;
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
  const provider = getActiveTaggingProvider() ?? (cfg.providers || [])[0];
  if (!provider) throw new Error("No tagging.providers configured.");
  const { models } = await detectModels([provider]);
  const model = cfg.model ?? models[0]?.id;
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

export function isLlmKind(kind) {
  return jobSpec(kind)?.llm === true;
}

// Buttons that ship with Skyhook, so a consumer needs no config to get them.
const BUILTIN_TAG_JOBS = {
  "tag-retry-failed": { label: "Retry failed URLs", args: ["tag", "--retry-failed"] },
  "tag-untagged": { label: "Tag URLs with no tags", args: ["tag", "--requeue-untagged"] },
};

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Resolve a pipeline job: the config's `pipeline.jobs` entry wins, then a
 * built-in. `llm` is true when the job runs `skyhook tag`, because only one LLM
 * worker may use the model endpoint at a time (see `startPipelineJob`).
 */
export function jobSpec(kind) {
  const job = pipelineConfig().jobs?.[kind];
  if (job) {
    const command = Array.isArray(job.command) ? job.command : [];
    return { ...job, command, llm: job.llm === true || command.includes("tag") };
  }
  const builtin = BUILTIN_TAG_JOBS[kind];
  if (builtin) {
    return {
      label: builtin.label,
      command: [join(PACKAGE_ROOT, "bin", "skyhook.js"), ...builtin.args],
      llm: true,
    };
  }
  // Legacy kinds with no `jobs` block: the in-process handlers below.
  if (kind === "tag" || kind === "retag-add" || kind === "retag-replace" ||
      (typeof kind === "string" && kind.startsWith("task:"))) {
    return { label: kind, command: [], llm: true };
  }
  return null;
}

export function startPipelineJob(kind) {
  const job = jobSpec(kind);
  if (job && job.command.length) {
    const [script, ...args] = job.command;
    const running = listRunning();
    if (running.some((r) => r.source === kind)) return { key: kind, alreadyRunning: true };
    // Only one LLM worker at a time (they share the local model endpoint).
    if (job.llm && running.some((r) => isLlmKind(r.source))) return { key: kind, alreadyRunning: true };
    runJob({ key: kind, scriptPath: script, args })
      .then(() => {})
      .catch((err) => console.error(`pipeline ${kind} error:`, err.message));
    return { key: kind, alreadyRunning: false };
  }
  if (kind === "push") {
    pushStagedToStorage()
      .then((r) => console.log("[pipeline] push:", JSON.stringify(r)))
      .catch((e) => console.error("[pipeline] push error:", e.message));
    return { key: "push", alreadyRunning: false };
  }
  if (kind === "tag") {
    runTag()
      .then((r) => console.log("[pipeline] tag:", JSON.stringify(r)))
      .catch((e) => console.error("[pipeline] tag error:", e.message));
    return { key: "tag", alreadyRunning: false };
  }
  return null;
}
