/**
 * data.js — cache + staged-result management (curation / prune / trash).
 *
 * Lets the user inspect and delete collected URLs per seeder / category /
 * subcategory / date, and clear a source's discovery cache. Deletions on the
 * staged working set are soft by default: removed rows are archived to
 * `dataDir/trash/` so they can be restored.
 */
import {
  readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync,
} from "fs";
import { join } from "path";
import { getConfig } from "../config.js";
import {
  stagedDir, safe, listStagedFiles, readStaged, writeStagedSource,
  filterRows, groupBySource, mergeRows,
} from "./staged.js";

/** Overview of both the staged working set and per-source discovery cache. */
export function listCache() {
  const cfg = getConfig();
  const staged = listStagedFiles();
  const dataDir = cfg.dataDir;
  const discovery = existsSync(dataDir)
    ? readdirSync(dataDir)
      .filter((f) => f.endsWith(".json") && f !== "seeders-manifest.json" && f !== "seeders-descriptions.json" && f !== "settings.json")
      .map((f) => {
        const p = join(dataDir, f);
        return { source: f.replace(/\.json$/, ""), file: p, bytes: existsSync(p) ? readFileSync(p).length : 0 };
      })
      .sort((a, b) => b.bytes - a.bytes)
    : [];
  return { staged, discovery, stagedDir: stagedDir(), dataDir };
}

function trashFile() {
  const dir = join(getConfig().dataDir, "trash");
  mkdirSync(dir, { recursive: true });
  return join(dir, `deleted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`);
}

/**
 * Delete staged rows matching a filter. `soft` archives them to trash instead
 * of destroying them. Returns { deleted, kept }.
 */
export function pruneStaged(filter = {}, { soft = true } = {}) {
  const rows = readStaged();
  const matched = filterRows(rows, filter);
  if (!matched.length) return { deleted: 0, kept: rows.length, archived: null };

  const matchedUrls = new Set(matched.map((r) => r.url));
  const keep = rows.filter((r) => !matchedUrls.has(r.url));

  // Rewrite every source's staged file, including sources that lost all rows,
  // so their file is deleted rather than left behind with stale content.
  const keepBySource = groupBySource(keep);
  for (const src of groupBySource(rows).keys()) {
    writeStagedSource(src, keepBySource.get(src) || []);
  }

  let archived = null;
  if (soft) {
    archived = trashFile();
    writeFileSync(archived, matched.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return { deleted: matched.length, kept: keep.length, archived };
}

/** Clear a source's discovery cache (forces a re-fetch on next run). */
export function clearDiscovery(source) {
  const file = join(getConfig().dataDir, `${safe(source)}.json`);
  if (existsSync(file)) {
    unlinkSync(file);
    return { source, cleared: true };
  }
  return { source, cleared: false };
}

/** Clear staged results for a source entirely (also archives to trash). */
export function clearStaged(source, { soft = true } = {}) {
  return pruneStaged({ source }, { soft });
}
