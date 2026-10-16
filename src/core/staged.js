/**
 * staged.js — helpers over the offline staged JSONL working set.
 *
 * Staged rows are one JSON object per line in `stagedDir/<source>.jsonl`, with
 * canonical fields plus `staged_at`. This is the working set for curation,
 * tagging, merge (Pi ⇄ PC), and push-to-storage. Every function here is
 * synchronous and path-driven so it works identically on the Pi and the PC.
 */
import {
  readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync,
} from "fs";
import { join } from "path";
import { getConfig } from "../config.js";

export const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);

export function stagedDir() {
  return getConfig().stagedDir;
}

/** Per-file summary of staged JSONL (for the cache/curation UI).
 *  `originalSource` is the source string actually written into the rows
 *  (may differ from the safe filename when the source contains characters
 *  like "." that get rewritten by `safe()`). Use it for prune/clear. */
export function listStagedFiles() {
  const dir = stagedDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = join(dir, f);
      const raw = readFileSync(file, "utf8");
      const lines = raw.split("\n");
      const count = lines.filter((l) => l.trim()).length;
      const filename = f.replace(/\.jsonl$/, "");
      let originalSource = filename;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row && typeof row.source === "string" && row.source) {
            originalSource = row.source;
            break;
          }
        } catch { /* skip malformed */ }
      }
      return { source: filename, originalSource, file, count, bytes: Buffer.byteLength(raw) };
    })
    .sort((a, b) => b.count - a.count);
}

/** Read all (or one source's) staged rows. */
export function readStaged({ source = null } = {}) {
  const dir = stagedDir();
  const rows = [];
  if (!existsSync(dir)) return rows;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    if (source && f !== `${safe(source)}.jsonl`) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* skip malformed */ }
    }
  }
  return rows;
}

/** Rewrite one source's staged file (creates or deletes when empty). */
export function writeStagedSource(source, rows) {
  const dir = stagedDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safe(source)}.jsonl`);
  if (rows.length) {
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
  return rows.length;
}

/** Dedup-union a list of row-lists by a key (default url); first writer wins. */
export function mergeRows(lists, key = "url") {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const r of list || []) {
      const k = r[key];
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/**
 * Select rows matching a deletion/curation filter. Fields match exactly;
 * `before`/`after` compare against `staged_at` (fallback `published_at`).
 */
export function filterRows(rows, { source, category, subcategory, language, url, before, after } = {}) {
  const beforeTs = before ? Date.parse(before) : null;
  const afterTs = after ? Date.parse(after) : null;
  return rows.filter((r) => {
    if (source && r.source !== source) return false;
    if (category && r.category_id !== category) return false;
    if (subcategory && r.subcategory_id !== subcategory) return false;
    if (language && r.language !== language) return false;
    if (url && r.url !== url) return false;
    if (beforeTs || afterTs) {
      const ts = Date.parse(r.staged_at || r.published_at);
      if (!Number.isFinite(ts)) return false;
      if (beforeTs && ts >= beforeTs) return false;
      if (afterTs && ts <= afterTs) return false;
    }
    return true;
  });
}

export function groupBySource(rows) {
  const map = new Map();
  for (const r of rows) {
    const src = r.source || "manual";
    if (!map.has(src)) map.set(src, []);
    map.get(src).push(r);
  }
  return map;
}
