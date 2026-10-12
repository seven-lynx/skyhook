/**
 * index.js — public entry point.
 */
export { loadConfig, getConfig, nodeId } from "./config.js";
export { loadSettings, saveSettings, allowRemote, settingsView } from "./core/settings.js";
export {
  localNodeId, isRemoteEnabled, remoteToken, getPeers, peerFor, routeSeeders,
  ping, forwardRun, forwardSchedule, pullStaged, pushStaged, runRemote,
} from "./core/remote.js";
export {
  stagedDir, safe, listStagedFiles, readStaged, writeStagedSource, mergeRows,
  filterRows, groupBySource,
} from "./core/staged.js";
export { mergeRemoteRows, mergedRows, pushStagedToStorage, pullPeer } from "./core/sync.js";
export { aggregateRows, statsFromStaged, humanize } from "./core/analytics.js";
export { listCache, pruneStaged, clearDiscovery, clearStaged } from "./core/data.js";

export * from "./core/seed.js";
export * from "./engine/seeder-engine.js";

export {
  createStorage, registerStorage, loadSchema, mapRow, CANONICAL_FIELDS,
} from "./adapters/storage/index.js";
export {
  loadCategories, getCategories, findSubcategory, getSubcategoryId,
} from "./adapters/categories/index.js";
export { detectModels, tag, buildPrompt, loadText } from "./adapters/tagging/index.js";
export { logRun, logCrash, queryRuns, getStats, runLogFile } from "./adapters/log/run-log.js";
