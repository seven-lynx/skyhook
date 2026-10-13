/**
 * api-server.js — HTTP JSON API over the seeder engine.
 *
 * This is the centralisation layer: the Windows/Pi web GUI (served from / via
 * src/gui/), a browser, or curl can drive seeding over the LAN with no SSH.
 * Zero framework — Node's built-in http server. CORS is open so the GUI (any
 * origin) can call it.
 *
 * Endpoints:
 *   GET  /api/health            { ok, seeders, scheduled, due, errors }
 *   GET  /api/status            summary + due list
 *   GET  /api/seeders           all seeders (?filter=, ?tier=, ?scheduled=1)
 *   GET  /api/seeders/:source   one seeder
 *   GET  /api/due               seeders due now
 *   GET  /api/history/:source   recent runs
 *   POST /api/run               { sources: [], parallel? }
 *   POST /api/schedule          { source, cadence?, isNews?, maxAgeDays? }
 *   POST /api/enable            { source, cadence? }
 *   POST /api/disable           { source }
 *   GET  /api/timer             current timer plan
 *   POST /api/timer             regenerate .skyhook/skyhook-seed.timer
 *   GET  /api/running           { running: [...], batch: { total, completed, remaining, etaMs } }
 *   GET  /api/logs/:source      tail a seeder's live log (?tail=N)
 *   POST /api/stop              { source? } stop one or all active runs
 *   GET  /api/pipeline          offline tagging pipeline status
 *   POST /api/pipeline/tag      run sync → import → LLM tag
 *   POST /api/pipeline/push     upload tagged URLs + tags to Supabase
 *   POST /api/pipeline/export   incremental offline-DB refresh
 *   POST /api/pipeline/export-full  full rebuild (wipes local tag progress)
 *   GET  /api/tagging/missing   counts of URLs missing category/subcategory/
 *                               tags/content-type/quality/attributes
 *   POST /api/tagging/run       { task } launch a targeted LLM gap-filling pass
 */
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { join, normalize, extname, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildIndex, openState, getState, listRuns, runPool, editManifest,
  enableSeeder, disableSeeder, emitTimer, writeTimer, resolveSeeder, isDue,
  listRunning, runProgress, stopRun, stopAll, logPath, runJob,
  listCategories, fetchSiteMeta, createSeeder, deleteSeeder,
} from "../engine/seeder-engine.js";
import { pipelineStatus, startPipelineJob } from "./pipeline.js";
import { nodeId, getConfig } from "../config.js";
import {
  routeSeeders, peerFor, runRemote, forwardSchedule, remoteToken,
} from "../core/remote.js";
import { loadSettings, saveSettings, settingsView, allowRemote } from "../core/settings.js";
import { readStaged } from "../core/staged.js";
import { mergeRemoteRows, pushStagedToStorage } from "../core/sync.js";
import { statsFromStaged } from "../core/analytics.js";
import { listCache, pruneStaged, clearDiscovery, clearStaged } from "../core/data.js";
import { countMissingSync } from "../adapters/tagging/tasks.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUI_DIR = join(__dirname, "..", "gui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

function seederView(s, st) {
  return {
    source: s.source,
    script: s.script,
    displayName: s.displayName,
    cadence: s.cadence,
    scheduled: s.scheduled,
    isNews: s.isNews,
    maxAgeDays: s.maxAgeDays,
    category: s.category,
    subcategory: s.subcategory,
    categoryLabel: s.categoryLabel,
    subcategoryLabel: s.subcategoryLabel,
    node: s.node ?? null,
    access: s.access,
    description: s.description ?? null,
    lastRunAt: st?.last_run_at ?? null,
    lastStatus: st?.last_status ?? null,
    lastResult: st?.last_result ? JSON.parse(st.last_result) : null,
    lastDurationMs: st?.last_duration_ms ?? null,
    lastError: st?.last_error ?? null,
    nextRunAt: st?.next_run_at ?? null,
  };
}

export function startServer(port = 4173) {
  const db = openState();
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    try {
      // Token gate on all mutating requests (shared secret across PC/Pi).
      if (method === "POST") {
        const token = remoteToken();
        if (token) {
          const h = req.headers.authorization || "";
          const provided = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-skyhook-token"] || "");
          if (provided !== token) return send(res, 403, { error: "invalid or missing token" });
        }
      }

      if (method === "GET" && path === "/api/health") {
        const idx = buildIndex();
        const due = idx.filter((s) => isDue(s, getState(db, s.source)));
        const errors = idx.filter((s) => { const st = getState(db, s.source); return st && st.last_status && st.last_status !== "ok"; });
        return send(res, 200, { ok: true, seeders: idx.length, scheduled: idx.filter((s) => s.scheduled).length, due: due.length, errors: errors.length });
      }

      if (method === "GET" && path === "/api/status") {
        const idx = buildIndex();
        const due = idx.filter((s) => isDue(s, getState(db, s.source)));
        return send(res, 200, {
          total: idx.length,
          scheduled: idx.filter((s) => s.scheduled).length,
          due: due.length,
          dueList: due.slice(0, 200).map((s) => seederView(s, getState(db, s.source))),
          running: listRunning(),
        });
      }

      if (method === "GET" && path === "/api/due") {
        const idx = buildIndex();
        return send(res, 200, idx.filter((s) => isDue(s, getState(db, s.source))).map((s) => seederView(s, getState(db, s.source))));
      }

      if (method === "GET" && path === "/api/seeders") {
        const idx = buildIndex();
        const filter = (url.searchParams.get("filter") || "").toLowerCase();
        const tier = url.searchParams.get("tier");
        const scheduledOnly = url.searchParams.get("scheduled") === "1";
        let rows = idx;
        if (filter) rows = rows.filter((s) => s.source.toLowerCase().includes(filter) || s.script.includes(filter) || (s.displayName || "").toLowerCase().includes(filter) || (s.category || "").toLowerCase().includes(filter));
        if (tier === "news") rows = rows.filter((s) => s.isNews);
        if (tier === "evergreen") rows = rows.filter((s) => !s.isNews);
        if (scheduledOnly) rows = rows.filter((s) => s.scheduled);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "1000", 10), 5000);
        return send(res, 200, rows.slice(0, limit).map((s) => seederView(s, getState(db, s.source))));
      }

      if (method === "GET" && /^\/api\/seeders\/.+/.test(path)) {
        const source = decodeURIComponent(path.split("/").pop());
        const s = resolveSeeder(source);
        if (!s) return send(res, 404, { error: `no seeder "${source}"` });
        return send(res, 200, seederView(s, getState(db, s.source)));
      }

      if (method === "GET" && path === "/api/categories") {
        return send(res, 200, listCategories());
      }

      if (method === "GET" && /^\/api\/history\/.+/.test(path)) {
        const source = decodeURIComponent(path.split("/").pop());
        return send(res, 200, listRuns(db, source, 100));
      }

      if (method === "GET" && path === "/api/timer") {
        return send(res, 200, emitTimer(buildIndex()));
      }

      if (method === "POST" && path === "/api/timer") {
        const info = emitTimer(buildIndex());
        writeTimer(buildIndex());
        return send(res, 200, { ok: true, ...info });
      }

      if (method === "POST" && path === "/api/run") {
        const body = await readBody(req);
        const idx = buildIndex();
        const selected = (body.sources || []).map((q) => resolveSeeder(q, idx)).filter(Boolean);
        if (!selected.length) return send(res, 400, { error: "no valid sources" });
        const concurrency = Math.max(1, Number(body.parallel || body.concurrency || 1));
        const opts = {
          concurrency,
          withHeadless: !!body.withHeadless,
          aggressive: !!body.aggressive,
          forceHeadless: !!body.forceHeadless,
          noCache: !!body.noCache,
        };
        const { local, remote } = routeSeeders(selected);
        const remoteResults = [];
        for (const [peerId, seeders] of remote) {
          const peer = peerFor(peerId);
          if (!peer) { remoteResults.push({ peer: peerId, error: `no peer configured for node "${peerId}"` }); continue; }
          try {
            remoteResults.push(await runRemote(peer, seeders, opts));
          } catch (err) {
            remoteResults.push({ peer: peerId, error: err.message });
          }
        }
        if (local.length) {
          runPool(local, opts).catch((err) => console.error("run error:", err.message));
        }
        return send(res, 200, {
          ok: true,
          started: local.map((s) => s.source),
          forwarded: [...remote.keys()],
          remoteResults,
          concurrency,
          withHeadless: opts.withHeadless,
        });
      }

      if (method === "POST" && path === "/api/schedule") {
        const body = await readBody(req);
        const entry = editManifest({ query: body.source, cadence: body.cadence, isNews: body.isNews, maxAgeDays: body.maxAgeDays, node: body.node });
        if (!entry) return send(res, 400, { error: `no unique match for "${body.source}"` });
        if (entry.node && entry.node !== nodeId()) {
          const peer = peerFor(entry.node);
          if (peer) forwardSchedule(peer, { source: entry.source, cadence: entry.cadence, isNews: entry.isNews, maxAgeDays: entry.maxAgeDays }).catch(() => {});
        }
        return send(res, 200, { ok: true, entry });
      }

      if (method === "POST" && path === "/api/enable") {
        const body = await readBody(req);
        const entry = enableSeeder(body.source, body.cadence || "weekly");
        if (!entry) return send(res, 400, { error: `no unique match for "${body.source}"` });
        return send(res, 200, { ok: true, entry });
      }

      if (method === "POST" && path === "/api/disable") {
        const body = await readBody(req);
        const s = disableSeeder(body.source);
        if (!s) return send(res, 400, { error: `"${body.source}" not scheduled or not unique` });
        return send(res, 200, { ok: true, source: s.source });
      }

      if (method === "POST" && path === "/api/seeders/preview") {
        const body = await readBody(req);
        try {
          const meta = await fetchSiteMeta(body.url);
          let siteDomain = "", source = "";
          try {
            const u = new URL(String(body.url || "").trim());
            siteDomain = u.hostname.replace(/^www\./, "");
            source = siteDomain.replace(/\./g, "-");
          } catch {}
          return send(res, 200, { ok: true, ...meta, siteDomain, source });
        } catch (err) {
          return send(res, 502, { error: err.message });
        }
      }

      if (method === "POST" && path === "/api/seeders/new") {
        const body = await readBody(req);
        try {
          const seeder = createSeeder(body);
          if (!seeder) return send(res, 500, { error: "seeder created but could not be indexed" });
          return send(res, 200, { ok: true, seeder: seederView(seeder, getState(db, seeder.source)) });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }

      if (method === "POST" && path === "/api/seeders/delete") {
        const body = await readBody(req);
        const s = deleteSeeder(body.source);
        if (!s) return send(res, 400, { error: `no unique match for "${body.source}"` });
        return send(res, 200, { ok: true, source: s.source });
      }

      if (method === "GET" && path === "/api/running") {
        return send(res, 200, { running: listRunning(), batch: runProgress() });
      }

      if (method === "GET" && /^\/api\/logs\/.+/.test(path)) {
        const source = decodeURIComponent(path.split("/").pop());
        const file = logPath(source);
        if (!existsSync(file)) return send(res, 200, { source, lines: [] });
        const tail = Math.min(Number(url.searchParams.get("tail") || 300) || 300, 2000);
        const content = readFileSync(file, "utf8");
        return send(res, 200, { source, lines: content.split("\n").slice(-tail) });
      }

      if (method === "POST" && path === "/api/stop") {
        const body = await readBody(req);
        let stopped;
        if (body.source) stopped = stopRun(body.source) ? [body.source] : [];
        else stopped = stopAll();
        return send(res, 200, { ok: true, stopped });
      }

      if (method === "GET" && path === "/api/pipeline") {
        return send(res, 200, pipelineStatus());
      }

      if (method === "POST" && path.startsWith("/api/pipeline/")) {
        const kind = path.slice("/api/pipeline/".length);
        const job = startPipelineJob(kind);
        if (!job) return send(res, 404, { error: "unknown pipeline action" });
        if (job.alreadyRunning) return send(res, 409, { error: `${job.key} already running` });
        return send(res, 200, { ok: true, job: job.key, kind });
      }

      // ── node settings (the Pi "operate remotely" toggle) ──────────────────
      if (method === "GET" && path === "/api/settings") {
        return send(res, 200, settingsView());
      }

      if (method === "POST" && path === "/api/settings") {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.allowRemote === "boolean") patch.allowRemote = body.allowRemote;
        saveSettings(patch);
        return send(res, 200, { ok: true, settings: settingsView() });
      }

      // ── staged results (export / import across nodes) ─────────────────────
      if (method === "GET" && path === "/api/staged") {
        const source = url.searchParams.get("source") || null;
        return send(res, 200, { rows: readStaged({ source }) });
      }

      if (method === "POST" && path === "/api/staged/import") {
        if (!allowRemote()) return send(res, 403, { error: "remote control is disabled (toggle allowRemote)" });
        const body = await readBody(req);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        return send(res, 200, { ok: true, ...mergeRemoteRows(rows) });
      }

      // ── analytics ──────────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/stats") {
        const source = url.searchParams.get("source") || null;
        return send(res, 200, statsFromStaged({ source }));
      }

      // ── tagging gaps (missing info counts from the offline DB) ─────────
      if (method === "GET" && path === "/api/tagging/missing") {
        const dbPath = getConfig().pipeline?.offlineDb;
        return send(res, 200, countMissingSync(dbPath));
      }

      // ── tagging task run (launch a targeted LLM pass) ──────────────────
      if (method === "POST" && path === "/api/tagging/run") {
        const body = await readBody(req);
        const taskKey = (body.task || "").trim();
        if (!taskKey) return send(res, 400, { error: "task is required" });
        const c = getConfig();
        if (!c.pipeline?.offlineDb) return send(res, 400, { error: "pipeline.offlineDb not configured" });
        if (listRunning().some((r) => r.source === `task:${taskKey}`)) {
          return send(res, 409, { error: `task:${taskKey} already running` });
        }
        // Launch via runJob — the task worker runs as a CLI subprocess so it
        // shows up in the live-log drawer with its own tab.
        const jobKey = `task:${taskKey}`;
        const skyhookPath = join(__dirname, "..", "..", "bin", "skyhook.js");
        runJob({ key: jobKey, scriptPath: skyhookPath, args: ["tag", "--task", taskKey] })
          .then(() => {})
          .catch((err) => console.error(`task ${taskKey} error:`, err.message));
        return send(res, 200, { ok: true, job: jobKey, task: taskKey });
      }

      // ── cache / curation (delete staged URLs before tagging) ──────────────
      if (method === "GET" && path === "/api/cache") {
        return send(res, 200, listCache());
      }

      if (method === "POST" && path === "/api/cache/prune") {
        const body = await readBody(req);
        const result = pruneStaged(body.filter || {}, { soft: body.soft !== false });
        return send(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && path === "/api/cache/clear") {
        const body = await readBody(req);
        if (body.kind === "discovery") return send(res, 200, clearDiscovery(body.source));
        return send(res, 200, clearStaged(body.source, { soft: body.soft !== false }));
      }

      // ── push staged → storage (deduped) ───────────────────────────────────
      if (method === "POST" && path === "/api/push") {
        const result = await pushStagedToStorage();
        return send(res, 200, { ok: true, ...result });
      }

      if (method === "GET" && !path.startsWith("/api/")) {
        const rel = path === "/" ? "index.html" : path.slice(1);
        const abs = normalize(join(GUI_DIR, rel));
        if (abs.startsWith(GUI_DIR) && existsSync(abs) && statSync(abs).isFile()) {
          res.writeHead(200, {
            "Content-Type": MIME[extname(abs)] || "application/octet-stream",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            ...CORS,
          });
          return res.end(readFileSync(abs));
        }
        return send(res, 404, { error: "not found" });
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`\n🛰  Skyhook seeder API listening on http://localhost:${port}`);
    console.log(`   GUI:  http://localhost:${port}/`);
    console.log(`   API:  http://localhost:${port}/api/health\n`);
  });
  return server;
}
