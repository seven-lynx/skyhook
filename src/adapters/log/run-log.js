/**
 * log/run-log.js — local JSONL run logger (no database dependency).
 *
 * Generic replacement for the host's `log-seeding.mjs`. Appends one JSON
 * object per line to a run log file (default `<logDir>/runs.jsonl`).
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export function runLogFile(config = {}) {
  return config.logFile || join(config.logDir || ".skyhook/logs", "runs.jsonl");
}

function ensure(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function logRun(run, config = {}) {
  const file = runLogFile(config);
  ensure(file);
  const entry = {
    type: "run",
    seeder: run.seeder,
    display_name: run.displayName ?? null,
    source: run.source,
    category: run.category ?? null,
    subcategory: run.subcategory ?? null,
    discovered: run.discovered ?? 0,
    inserted: run.inserted ?? 0,
    skipped: run.skipped ?? 0,
    dead: run.dead ?? 0,
    error: run.error ?? null,
    duration_ms: run.duration_ms ?? null,
    method: run.method ?? null,
    started_at: run.started_at ?? new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`[run-log] Failed to write log for ${run.seeder}: ${err.message}`);
  }
  return entry;
}

export async function logCrash(crash, config = {}) {
  const file = runLogFile(config);
  ensure(file);
  const entry = {
    type: "crash",
    seeder: crash.seeder,
    display_name: crash.displayName ?? null,
    error: crash.error ?? null,
    method: crash.method ?? null,
    started_at: crash.started_at ?? new Date().toISOString(),
  };
  try {
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`[run-log] Failed to write crash log: ${err.message}`);
  }
  return entry;
}

export function queryRuns({ file, days = 7, limit = 50, seeder } = {}) {
  if (!existsSync(file)) return [];
  const cutoff = Date.now() - days * 86400e3;
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { continue; }
    if (seeder && r.seeder !== seeder) continue;
    if (r.started_at && new Date(r.started_at).getTime() < cutoff) continue;
    rows.push(r);
  }
  rows.reverse();
  return rows.slice(0, limit);
}

export function getStats({ file, days = 7 } = {}) {
  const rows = queryRuns({ file, days, limit: 100000 });
  const latestPerSeeder = new Map();
  for (const r of rows) {
    if (!latestPerSeeder.has(r.seeder)) latestPerSeeder.set(r.seeder, r);
  }
  let totalInserted = 0, totalDead = 0, totalSkipped = 0, withErrors = 0, crashed = 0;
  for (const r of latestPerSeeder.values()) {
    totalInserted += r.inserted ?? 0;
    totalDead += r.dead ?? 0;
    totalSkipped += r.skipped ?? 0;
    if (r.type === "crash") crashed++;
    else if (r.error) withErrors++;
  }
  return {
    totalSeeders: latestPerSeeder.size,
    totalInserted, totalDead, totalSkipped,
    seedersWithErrors: withErrors,
    seedersWithCrashes: crashed,
    seeders: [...latestPerSeeder.values()],
  };
}
