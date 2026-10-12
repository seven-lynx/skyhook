/**
 * sync.js — merge Pi ⇄ PC staged results with URL dedup, and push to storage.
 *
 * The controller/worker model keeps the PC as the canonical owner of the DB;
 * the Pi (worker) stages locally and ships results back. `pullPeer()` merges a
 * peer's staged rows into the local set (first-writer-wins by URL), and
 * `pushStagedToStorage()` replays the merged set into the configured storage
 * adapter (which dedups again via its conflict key).
 */
import { readStaged, writeStagedSource, mergeRows, groupBySource } from "./staged.js";
import { createStorage } from "../adapters/storage/index.js";
import { getConfig } from "../config.js";
import { pullStaged } from "./remote.js";

export function mergedRows({ key = "url" } = {}) {
  return mergeRows([readStaged()], key);
}

/** Push the merged staged set into the configured storage. */
export async function pushStagedToStorage({ key = "url" } = {}) {
  const storage = await createStorage(getConfig());
  const rows = mergedRows({ key });
  if (!rows.length) return { pushed: 0, skipped: 0, total: 0 };
  const result = await storage.upsert(rows);
  return { pushed: result.inserted ?? 0, skipped: result.skipped ?? 0, total: rows.length };
}

/** Merge a peer's staged rows into local staged files (dedup by URL). */
export function mergeRemoteRows(remoteRows, { key = "url" } = {}) {
  const before = readStaged();
  const merged = mergeRows([before, remoteRows], key);
  let written = 0;
  for (const [src, rows] of groupBySource(merged)) written += writeStagedSource(src, rows);
  return { total: merged.length, added: merged.length - before.length, sources: groupBySource(merged).size, written };
}

/** Pull a peer's staged rows and merge them locally. */
export async function pullPeer(peer) {
  const data = await pullStaged(peer);
  const remoteRows = Array.isArray(data.rows) ? data.rows : (Array.isArray(data) ? data : []);
  return mergeRemoteRows(remoteRows);
}
