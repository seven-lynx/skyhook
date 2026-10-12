/**
 * seeder-engine.js — headless core for all seeding management.
 *
 * Single source of truth for: seeder discovery, schedule (manifest overlay),
 * run execution with result capture, and run history. No UI of its own — the
 * CLI (skyhook.js), the TUI, and the future Windows/Pi GUI all call into this.
 *
 * Runs identically on the Raspberry Pi (stage-only, no Supabase) and the PC.
 */
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
  createWriteStream, unlinkSync,
} from "fs";
import { resolve, dirname, join, basename } from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";
import Database from "better-sqlite3";
import { CATEGORY, SUBCATEGORY, SUBCATEGORY_BY_CATEGORY } from "../core/seed.js";
import { logCrash } from "../adapters/log/run-log.js";
import { getConfig, nodeId } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = getConfig();

export const SCRIPTS_DIR  = cfg.seedersDir;     // where seed-*.js live
export const ROOT         = process.cwd();     // spawn cwd
export const MANIFEST_FILE = cfg.manifestFile;
export const DESCRIPTIONS_FILE = cfg.descriptionsFile;
export const CACHE_DIR    = cfg.dataDir;
export const STATE_DB     = cfg.stateDb;
export const LOGS_DIR     = cfg.logDir;
export const STAGED_DIR   = cfg.stagedDir;
export const TIMER_FILE   = join(cfg.dataDir, "skyhook-seed.timer");

export const CADENCE_MS = {
  hourly: 3600e3,
  "6h": 6 * 3600e3,
  "12h": 12 * 3600e3,
  daily: 24 * 3600e3,
  weekly: 7 * 24 * 3600e3,
  monthly: 30 * 24 * 3600e3,
  manual: Infinity,
};
export const CADENCES = Object.keys(CADENCE_MS);

// Pillar display names (CATEGORY constant → human label). Subcategories are
// humanised generically from their constant name.
const CATEGORY_LABELS = {
  SCIENCE: "Science & Nature",
  TECHNOLOGY: "Technology",
  ARTS_CULTURE: "Arts & Culture",
  HISTORY_IDEAS: "History & Ideas",
  GAMES_HOBBIES: "Games & Hobbies",
  WEIRD_WONDERFUL: "Weird & Wonderful",
  PEOPLE_PLACES: "People & Places",
  MIND_BODY: "Mind & Body",
};

function humanize(constName) {
  if (!constName) return null;
  if (CATEGORY_LABELS[constName]) return CATEGORY_LABELS[constName];
  return constName
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Discovery + metadata ────────────────────────────────────────────────────

/** Parse a seeder's JSDoc header for display name, category, subcategory, access. */
function parseHeader(text) {
  let displayName = null;
  const dm = text.match(/^\s*\*\s*seed-[^\n]*?\s—\s(.+)$/m);
  if (dm) {
    displayName = dm[1].trim()
      .replace(/\s*\(.*\)\s*$/, "")
      .replace(/\s+seeder\s*$/i, "")
      .trim();
  }

  let category = null, subcategory = null;
  const cm = text.match(/^\s*\*\s*Category:\s*([A-Za-z0-9_.]+)\s*→\s*([A-Za-z0-9_.]+)\s*$/m);
  if (cm) {
    category = cm[1].replace(/^CATEGORY\./, "");
    subcategory = cm[2].replace(/^SUBCATEGORY\./, "");
  }

  let access = null;
  const am = text.match(/^\s*\*\s*Access:\s*(.+?)\s*$/m);
  if (am) access = am[1].trim();

  let description = null;
  const descM = text.match(/^\s*\*\s*Description:\s*(.+?)\s*$/m);
  if (descM) description = descM[1].trim();

  return { displayName, category, subcategory, access, description };
}

/** Discover every `seed-*.js|mjs|cjs` file in the configured seeders dir. */
export function discoverSeeders() {
  if (!existsSync(SCRIPTS_DIR)) return [];
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => /^seed-.+\.(js|mjs|cjs)$/.test(f))
    .sort()
    .map((script) => {
      const source = script.replace(/^seed-/, "").replace(/\.(js|mjs|cjs)$/, "");
      const header = readFileSync(join(SCRIPTS_DIR, script), "utf8").slice(0, 2000);
      return { script, source, ...parseHeader(header) };
    });
}

export function loadManifest() {
  if (!existsSync(MANIFEST_FILE)) return { seeders: [], defaults: {} };
  try { return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")); } catch { return { seeders: [], defaults: {} }; }
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
}

/** Load generated seeder descriptions (seeders-descriptions.json), if present. */
export function loadDescriptions() {
  if (!existsSync(DESCRIPTIONS_FILE)) return {};
  try { return JSON.parse(readFileSync(DESCRIPTIONS_FILE, "utf8")); } catch { return {}; }
}

/**
 * Full index = discovery (all 606) + manifest overlay (schedule config).
 * Seeders absent from the manifest are `manual` (browsable/runnable, not
 * auto-scheduled). Manifest entries without an explicit cadence fall back to
 * `defaults.cadence`.
 */
export function buildIndex() {
  const manifest = loadManifest();
  const descriptions = loadDescriptions();
  const defaults = manifest.defaults || {};
  const byScript = new Map((manifest.seeders || []).map((s) => [s.script, s]));

  return discoverSeeders().map((d) => {
    const cfg = byScript.get(d.script) || {};
    const scheduled = byScript.has(d.script);
    return {
      ...d,
      scheduled,
      cadence: cfg.cadence ?? (scheduled ? (defaults.cadence ?? "weekly") : "manual"),
      isNews: !!(cfg.isNews ?? defaults.isNews ?? false),
      maxAgeDays: cfg.maxAgeDays ?? defaults.maxAgeDays ?? null,
      concurrency: cfg.concurrency ?? defaults.concurrency ?? 2,
      skipHeadless: cfg.skipHeadless ?? defaults.skipHeadless ?? true,
      node: cfg.node ?? defaults.node ?? null,
      categoryId: CATEGORY[d.category] ?? null,
      subcategoryId: SUBCATEGORY[d.subcategory] ?? null,
      categoryLabel: d.category ? humanize(d.category) : null,
      subcategoryLabel: d.subcategory ? humanize(d.subcategory) : null,
      description: d.description ?? descriptions[d.script] ?? descriptions[d.source] ?? null,
    };
  });
}

/** Resolve a query (source, script, or unique substring) to one seeder. */
export function resolveSeeder(query, index = buildIndex()) {
  const q = String(query).trim();
  if (!q) return null;
  const exact = index.find((s) => s.source === q || s.script === q);
  if (exact) return exact;
  const matches = index.filter(
    (s) =>
      s.source.includes(q) ||
      s.script.includes(q) ||
      (s.displayName && s.displayName.toLowerCase().includes(q.toLowerCase())),
  );
  return matches.length === 1 ? matches[0] : null;
}

// ── State (SQLite) ──────────────────────────────────────────────────────────

export function openState() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const db = new Database(STATE_DB);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seeders (
      source          TEXT PRIMARY KEY,
      script          TEXT NOT NULL,
      cadence         TEXT,
      enabled         INTEGER DEFAULT 1,
      is_news         INTEGER DEFAULT 0,
      max_age_days    INTEGER,
      last_run_at     TEXT,
      last_status     TEXT,
      last_result     TEXT,
      last_duration_ms INTEGER,
      last_error      TEXT,
      next_run_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      duration_ms  INTEGER,
      status       TEXT NOT NULL,
      staged       INTEGER DEFAULT 0,
      dead         INTEGER DEFAULT 0,
      skipped      INTEGER DEFAULT 0,
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source);
  `);
  return db;
}

export function getState(db, source) {
  return db.prepare("SELECT * FROM seeders WHERE source = ?").get(source) ?? null;
}

export function listRuns(db, source, limit = 10) {
  return db
    .prepare("SELECT * FROM runs WHERE source = ? ORDER BY id DESC LIMIT ?")
    .all(source, limit);
}

export function recordRun(db, { source, script, cadence, isNews, maxAgeDays, startedAt, durationMs, status, result, error, nextRunAt }) {
  db.prepare(`
    INSERT INTO seeders (source, script, cadence, enabled, is_news, max_age_days, last_run_at, last_status, last_result, last_duration_ms, last_error, next_run_at)
    VALUES (@source, @script, @cadence, 1, @isNews, @maxAgeDays, @startedAt, @status, @result, @durationMs, @error, @nextRunAt)
    ON CONFLICT(source) DO UPDATE SET
      script = @script, cadence = @cadence, is_news = @isNews, max_age_days = @maxAgeDays,
      last_run_at = @startedAt, last_status = @status, last_result = @result,
      last_duration_ms = @durationMs, last_error = @error, next_run_at = @nextRunAt
  `).run({
    source, script, cadence, isNews: isNews ? 1 : 0, maxAgeDays: maxAgeDays ?? null,
    startedAt, status, result: result ? JSON.stringify(result) : null,
    durationMs: durationMs ?? null, error: error ?? null, nextRunAt: nextRunAt ?? null,
  });
  db.prepare(`
    INSERT INTO runs (source, started_at, duration_ms, status, staged, dead, skipped, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, startedAt, durationMs, status, result?.staged ?? 0, result?.dead ?? 0, result?.skipped ?? 0, error ?? null);
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export function isDue(seeder, stateRow, now = Date.now()) {
  if (seeder.cadence === "manual") return false;
  if (!stateRow?.last_run_at) return true;
  const interval = CADENCE_MS[seeder.cadence] ?? CADENCE_MS.weekly;
  if (!isFinite(interval)) return false;
  return now - new Date(stateRow.last_run_at).getTime() >= interval;
}

export function computeNextRun(cadence, lastRunAt, now = Date.now()) {
  if (cadence === "manual") return null;
  const interval = CADENCE_MS[cadence] ?? CADENCE_MS.weekly;
  if (!isFinite(interval)) return null;
  const base = lastRunAt ? new Date(lastRunAt).getTime() : now;
  return new Date(base + interval).toISOString();
}

// ── Manifest editing ────────────────────────────────────────────────────────

/** Add/update a seeder's schedule entry. Returns the updated entry or null. */
export function editManifest({ query, cadence, isNews, maxAgeDays, source, node }) {
  const index = buildIndex();
  const seeder = resolveSeeder(query, index);
  if (!seeder) return null;
  const manifest = loadManifest();
  let entry = manifest.seeders.find((e) => e.script === seeder.script);
  if (!entry) { entry = { script: seeder.script }; manifest.seeders.push(entry); }
  entry.source = source ?? entry.source ?? seeder.source;
  if (cadence !== undefined) entry.cadence = cadence;
  if (isNews !== undefined) entry.isNews = isNews;
  if (maxAgeDays !== undefined) entry.maxAgeDays = maxAgeDays === null ? null : Number(maxAgeDays);
  if (node !== undefined) entry.node = node === null ? null : String(node);
  saveManifest(manifest);
  return entry;
}

export function enableSeeder(query, cadence = "weekly") {
  return editManifest({ query, cadence });
}

export function disableSeeder(query) {
  const index = buildIndex();
  const seeder = resolveSeeder(query, index);
  if (!seeder) return null;
  const manifest = loadManifest();
  const before = manifest.seeders.length;
  manifest.seeders = manifest.seeders.filter((e) => e.script !== seeder.script);
  if (manifest.seeders.length === before) return null; // wasn't scheduled
  saveManifest(manifest);
  return seeder;
}

// ── Running ─────────────────────────────────────────────────────────────────

function safe(s) { return String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80); }

/** Absolute path to a seeder's log file (used by the live-log API). */
export function logPath(source) {
  return join(LOGS_DIR, `${safe(source)}.log`);
}

/** Pull the "Staged: X, Dead: Y" (or Inserted/Skipped) summary from output. */
function parseSummary(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let m = lines[i].match(/\[stage\] Done\. Staged:\s*(\d+), Dead:\s*(\d+)/);
    if (m) return { staged: +m[1], dead: +m[2], skipped: 0 };
    m = lines[i].match(/\[seed\] Done\. Inserted:\s*(\d+), Skipped:\s*(\d+)(?:, Dead:\s*(\d+))?/);
    if (m) return { staged: +m[1], skipped: +m[2], dead: +(m[3] ?? 0) };
  }
  return null;
}

function extractError(output) {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter(Boolean);

  // Node error output looks like:
  //   file:///path/to/seed-x.mjs:14
  //     <offending source line>
  //                   ^
  //   SyntaxError: Invalid or unexpected token
  //   (stack trace)
  let location = null;
  let message = null;
  for (const line of lines) {
    if (!location) {
      const m = line.match(/^(?:file:\/\/)?(.+?\.(?:mjs|js|cjs)):(\d+)\s*$/);
      if (m) location = { file: basename(m[1]), line: m[2] };
    }
    if (!message) {
      const m = line.match(/^([A-Za-z]*Error)\s*:\s*(.+)$/);
      if (m) message = `${m[1]}: ${m[2].trim()}`;
    }
  }
  if (message) {
    return `${location ? `${location.file}:${location.line} — ` : ""}${message}`.slice(0, 500);
  }

  // Fallback: last error-ish line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|fail|throw|cannot|missing|denied/i.test(lines[i])) return lines[i].slice(0, 300);
  }
  return null;
}

// ── Active-run registry (for live logs + stop) ─────────────────────────────
const activeRuns = new Map(); // source -> { child, startedAt, logFile, script }

export function listRunning() {
  return [...activeRuns.entries()].map(([source, r]) => ({
    source,
    script: r.script,
    startedAt: r.startedAt,
    elapsedMs: Date.now() - new Date(r.startedAt).getTime(),
    logFile: r.logFile,
  }));
}

// Run-batch progress (for "x/y remaining" + ETA in the GUI). One entry per
// runPool() invocation; the latest active batch wins; removed when it finishes.
const batches = [];

// Fallback duration for seeders with no recorded history yet.
const DEFAULT_DURATION_MS = 30_000;

export function runProgress() {
  const batch = batches.length ? batches[batches.length - 1] : null;
  if (!batch) return null;
  const now = Date.now();
  const elapsedMs = now - new Date(batch.startedAt).getTime();
  // Historical-duration ETA: sum each remaining seeder's expected duration,
  // subtracting elapsed time for ones already running, then divide by the
  // number of parallel workers. Available from t=0 (even for a single seeder).
  let remainingWorkMs = 0;
  for (const r of batch.remaining) {
    const active = activeRuns.get(r.source);
    remainingWorkMs += active
      ? Math.max(0, r.expectedMs - (now - new Date(active.startedAt).getTime()))
      : r.expectedMs;
  }
  const etaMs = batch.concurrency > 0 ? remainingWorkMs / batch.concurrency : null;
  return {
    total: batch.total,
    completed: batch.completed,
    remaining: batch.remaining.length,
    stagedTotal: batch.stagedTotal,
    concurrency: batch.concurrency,
    startedAt: batch.startedAt,
    elapsedMs,
    etaMs,
  };
}

export function stopRun(source) {
  const entry = activeRuns.get(source);
  if (!entry) return false;
  entry.stopped = true;
  killTree(entry.child);
  return true;
}

export function stopAll() {
  const stopped = [...activeRuns.keys()];
  for (const source of stopped) stopRun(source);
  return stopped;
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM"); // negative PID = whole process group
    }
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

/**
 * Run a standalone script (pipeline step) as a monitored job. Reuses the
 * active-run registry + per-job log so the GUI gets live logs + stop for free.
 * @param {{ key: string, scriptPath: string, args?: string[], env?: object }} job
 */
export function runJob({ key, scriptPath, args = [], env = {} }) {
  return new Promise((resolvePromise) => {
    mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = logPath(key);
    const logStream = createWriteStream(logFile, { flags: "a" });
    logStream.write(`\n── job ${key} ${new Date().toISOString()} ──\n`);

    let output = "";
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeRuns.set(key, { child, startedAt: new Date().toISOString(), logFile, script: key });

    const onData = (isErr) => (d) => {
      const s = d.toString();
      output = (output + s).slice(-64000); // bounded tail
      logStream.write(s);
      (isErr ? process.stderr : process.stdout).write(s);
    };
    child.stdout.on("data", onData(false));
    child.stderr.on("data", onData(true));

    child.on("close", (code, signal) => {
      logStream.end();
      const entry = activeRuns.get(key);
      activeRuns.delete(key);
      const stopped = (signal != null) || (entry && entry.stopped);
      const status = code === 0 ? "ok" : (stopped ? "stopped" : `error(${code ?? "signal"})`);
      resolvePromise({ key, status, code, output });
    });
    child.on("error", (err) => {
      logStream.end();
      activeRuns.delete(key);
      resolvePromise({ key, status: "spawn-error", code: null, output, error: err.message });
    });
  });
}

export function runOne(seeder, opts = {}) {
  return new Promise((resolvePromise) => {
    const scriptPath = join(SCRIPTS_DIR, seeder.script);
    if (!existsSync(scriptPath)) {
      resolvePromise({ seeder, status: "missing", durationMs: 0, result: null, error: "script not found" });
      return;
    }

    const cmdArgs = [scriptPath, "--stage-only"];
    if (seeder.maxAgeDays != null) cmdArgs.push("--max-age-days", String(seeder.maxAgeDays));
    if (opts.aggressive) cmdArgs.push("--aggressive");
    if (opts.forceHeadless) cmdArgs.push("--with-headless");
    if (opts.noCache) cmdArgs.push("--no-cache");
    const env = { ...process.env, SKYHOOK_STAGE_ONLY: "1" };
    // --aggressive / --force-headless override the headless skip; otherwise
    // honour the "headless" opt-out for seeders that have it disabled by default.
    if (seeder.skipHeadless && !opts.withHeadless && !opts.aggressive && !opts.forceHeadless) {
      env.SKYHOOK_SKIP_HEADLESS = "1";
    }

    mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = join(LOGS_DIR, `${safe(seeder.source)}.log`);
    const logStream = createWriteStream(logFile, { flags: "a" });
    logStream.write(`\n── run ${new Date().toISOString()} ──\n`);

    const started = Date.now();
    let output = "";
    const child = spawn(process.execPath, cmdArgs, {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeRuns.set(seeder.source, { child, startedAt: new Date().toISOString(), logFile, script: seeder.script });

    const onData = (isErr) => (d) => {
      const s = d.toString();
      output = (output + s).slice(-64000); // bounded tail for parsing
      logStream.write(s);
      if (opts.verbose !== false) (isErr ? process.stderr : process.stdout).write(s);
    };
    child.stdout.on("data", onData(false));
    child.stderr.on("data", onData(true));

    child.on("close", async (code, signal) => {
      logStream.end();
      const entry = activeRuns.get(seeder.source);
      activeRuns.delete(seeder.source);
      const durationMs = Date.now() - started;
      const result = parseSummary(output);
      const stopped = (signal != null) || (entry && entry.stopped);
      const status = code === 0 ? "ok" : (stopped ? "stopped" : `error(${code ?? "signal"})`);
      const error = code === 0 ? null : (stopped ? "stopped" : (extractError(output) ?? `exit code ${code}`));

      // Record failures in the central master log (seeding-runs.jsonl) so they
      // reach Supabase seeding_runs. Successes are self-logged by the seeders
      // via the seed core (src/core/seed.js), so only failures are logged here to avoid duplicates.
      if (error && !stopped) {
        try {
          await logCrash({
            seeder: seeder.source,
            displayName: seeder.displayName,
            error,
            started_at: new Date(started).toISOString(),
          });
        } catch { /* logging is best-effort */ }
      }

      resolvePromise({ seeder, status, durationMs, result, error });
    });
    child.on("error", (err) => {
      logStream.end();
      activeRuns.delete(seeder.source);
      resolvePromise({ seeder, status: "spawn-error", durationMs: Date.now() - started, result: null, error: err.message });
    });
  });
}

/** Run a set of seeders with a concurrency cap, recording every attempt. */
export function runPool(seeders, opts = {}) {
  const { concurrency = 2, verbose = true } = opts;
  const db = openState();
  const queue = [...seeders];
  const results = [];
  let running = 0;

  const batch = {
    total: seeders.length,
    completed: 0,
    stagedTotal: 0,
    concurrency,
    startedAt: new Date().toISOString(),
    remaining: seeders.map((s) => ({
      source: s.source,
      expectedMs: getState(db, s.source)?.last_duration_ms ?? DEFAULT_DURATION_MS,
    })),
  };
  batches.push(batch);

  return new Promise((resolveAll) => {
    const next = () => {
      if (queue.length === 0 && running === 0) return resolveAll();
      while (running < concurrency && queue.length > 0) {
        const seeder = queue.shift();
        running++;
        const startedAt = new Date().toISOString();
        runOne(seeder, { ...opts, verbose }).then((result) => {
          results.push(result);
          batch.completed++;
          batch.stagedTotal += result.result?.staged ?? 0;
          batch.remaining = batch.remaining.filter((r) => r.source !== seeder.source);
          recordRun(db, {
            source: seeder.source,
            script: seeder.script,
            cadence: seeder.cadence,
            isNews: seeder.isNews,
            maxAgeDays: seeder.maxAgeDays,
            startedAt,
            durationMs: result.durationMs,
            status: result.status,
            result: result.result,
            error: result.error,
            nextRunAt: computeNextRun(seeder.cadence, startedAt),
          });
          running--;
          next();
        });
      }
    };
    next();
  }).then(() => {
    const i = batches.indexOf(batch);
    if (i >= 0) batches.splice(i, 1);
    db.close();
    return results;
  });
}

/** Compute the due set for the systemd/CLI "run-due" entry point. */
export function dueSeeders(opts = {}) {
  const { tier = "all", source = null, force = false, node = null } = opts;
  const db = openState();
  const index = buildIndex();
  const me = nodeId();
  const seeders = index.filter((s) => {
    if (source && s.source !== source && s.script !== source) return false;
    if (node && (s.node ?? me) !== node) return false;
    if (tier === "news" && !s.isNews) return false;
    if (tier === "evergreen" && s.isNews) return false;
    return true;
  });
  const due = seeders.filter((s) => force || isDue(s, getState(db, s.source)));
  return { seeders, due, db, index };
}

// ── Systemd timer ───────────────────────────────────────────────────────────

export function timerOnCalendar(cadenceMs) {
  const h = cadenceMs / 3600e3;
  if (h >= 720) return "monthly";
  if (h >= 168) return "weekly";
  if (h >= 24) return "daily";
  if (h >= 12) return "0/12:00:00";
  if (h >= 6) return "0/6:00:00";
  if (h >= 1) return "hourly";
  return "daily";
}

/** Regenerate the systemd timer unit text from the fastest enabled cadence. */
export function emitTimer(seeders = buildIndex()) {
  const enabled = seeders.filter((s) => s.scheduled && s.cadence !== "manual");
  let fastestMs = Infinity;
  for (const s of enabled) {
    const ms = CADENCE_MS[s.cadence] ?? CADENCE_MS.weekly;
    if (isFinite(ms) && ms < fastestMs) fastestMs = ms;
  }
  const onCalendar = isFinite(fastestMs) ? timerOnCalendar(fastestMs) : "daily";
  const unit = `[Unit]
Description=Run Skyhook seeders (regenerated by skyhook emit-timer)

[Timer]
OnCalendar=${onCalendar}
Persistent=true

[Install]
WantedBy=timers.target
`;
  const fastestCadence = isFinite(fastestMs)
    ? Object.keys(CADENCE_MS).find((k) => CADENCE_MS[k] === fastestMs)
    : null;
  return { unit, onCalendar, fastestCadence };
}

export function writeTimer(seeders = buildIndex()) {
  const { unit } = emitTimer(seeders);
  mkdirSync(dirname(TIMER_FILE), { recursive: true });
  writeFileSync(TIMER_FILE, unit);
  return unit;
}

// ── Seeder creation / deletion (GUI "new seeder" flow) ──────────────────────

function slugifySource(s) {
  const t = String(s || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return t.slice(0, 60) || null;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlMeta(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;|&#x[0-9a-f]+;/gi, " ");
}

/** Categories + subcategories for the "new seeder" form (single source of truth). */
export function listCategories() {
  const subName = {};
  for (const [name, id] of Object.entries(SUBCATEGORY)) subName[id] = name;
  const catName = {};
  for (const [name, id] of Object.entries(CATEGORY)) catName[id] = name;
  return Object.entries(SUBCATEGORY_BY_CATEGORY).map(([catId, subIds]) => {
    const name = catName[catId];
    return {
      name,
      label: CATEGORY_LABELS[name] || humanize(name),
      subcategories: subIds.map((id) => ({ name: subName[id], label: humanize(subName[id]) })),
    };
  });
}

/** Fetch a site's <title> + OG/description to pre-fill the form. */
export async function fetchSiteMeta(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("URL must start with http:// or https://");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": getConfig().userAgent, Accept: "text/html,*/*" },
    });
    const html = await res.text();
    const doc = html.slice(0, 200000);
    const pick = (re) => {
      const m = doc.match(re);
      return m ? decodeHtmlMeta(m[1]) : null;
    };
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const description =
      pick(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]*content=["']([^"']*)["']/i) ||
      pick(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:property=["']og:description["']|name=["']description["'])/i);
    const siteName =
      pick(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i) ||
      pick(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i);
    const tidy = (s, n) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);
    return { title: tidy(title, 160), description: tidy(description, 160), siteName: tidy(siteName, 80) };
  } finally {
    clearTimeout(timer);
  }
}

function buildSeederFile({ slug, displayName, siteDomain, category, subcategory, feedUrl, description }) {
  const head = [
    "/**",
    ` * seed-${slug}.mjs — ${displayName} seeder`,
    ` * Category: CATEGORY.${category} → SUBCATEGORY.${subcategory}`,
    " * Access: RSS feed → Sitemap → Wayback",
    description ? ` * Description: ${description}` : null,
    " */",
  ].filter((l) => l !== null);
  const body = [
    `import { seedRssWithFallbacks, CATEGORY, SUBCATEGORY } from "skyhook";`,
    "",
    "await seedRssWithFallbacks({",
    `  siteDomain: ${JSON.stringify(siteDomain)},`,
    `  cacheFileName: ${JSON.stringify(`${slug}.json`)},`,
    `  displayName: ${JSON.stringify(displayName)},`,
    feedUrl ? `  feedUrl: ${JSON.stringify(feedUrl)},` : null,
    "  articlePathRegex: /[a-z0-9]/i,",
    `  siteSuffixRegex: /\\s*[|\\-–—]\\s*${escapeRegex(siteDomain)}\\s*$/i,`,
    `  category_id: CATEGORY.${category},`,
    `  subcategory_id: SUBCATEGORY.${subcategory},`,
    `  source: ${JSON.stringify(slug)},`,
    "  seeder_score: 0.7,",
    "});",
    "",
  ].filter((l) => l !== null);
  return [...head, ...body].join("\n");
}

/**
 * Write a new seeder file (and optionally a schedule entry) from a website URL.
 * Returns the new seeder's index entry, or throws a descriptive Error.
 */
export function createSeeder({ url, displayName, source, category, subcategory, feedUrl, description, cadence }) {
  let parsed;
  try { parsed = new URL(String(url || "").trim()); } catch { throw new Error("Invalid URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) throw new Error("Could not derive a site domain from that URL.");

  if (!category || !(category in CATEGORY)) throw new Error(`Unknown category "${category}".`);
  if (!subcategory || !(subcategory in SUBCATEGORY)) throw new Error(`Unknown subcategory "${subcategory}".`);

  const slug = slugifySource(source || host);
  if (!slug) throw new Error("Could not derive a source name from the URL.");
  const script = `seed-${slug}.mjs`;

  if (buildIndex().some((s) => s.script === script || s.source === slug)) {
    throw new Error(`A seeder named "${slug}" already exists.`);
  }

  const name = String(displayName || "").trim() || host;
  const cleanDesc = String(description || "").replace(/[\r\n]+/g, " ").trim();

  writeFileSync(join(SCRIPTS_DIR, script), buildSeederFile({
    slug,
    displayName: name,
    siteDomain: host,
    category,
    subcategory,
    feedUrl: String(feedUrl || "").trim(),
    description: cleanDesc,
  }), "utf8");

  if (cadence && cadence !== "manual") {
    editManifest({ query: slug, cadence });
  }

  return buildIndex().find((s) => s.source === slug) || null;
}

/** Delete a seeder: remove its file, manifest entry, run history, and log. */
export function deleteSeeder(query) {
  const seeder = resolveSeeder(query);
  if (!seeder) return null;

  const manifest = loadManifest();
  const before = manifest.seeders.length;
  manifest.seeders = manifest.seeders.filter((e) => e.script !== seeder.script);
  if (manifest.seeders.length !== before) saveManifest(manifest);

  try { unlinkSync(join(SCRIPTS_DIR, seeder.script)); } catch {}

  const db = openState();
  try {
    db.prepare("DELETE FROM seeders WHERE source = ?").run(seeder.source);
    db.prepare("DELETE FROM runs WHERE source = ?").run(seeder.source);
  } finally {
    db.close();
  }

  try { unlinkSync(logPath(seeder.source)); } catch {}

  return seeder;
}
