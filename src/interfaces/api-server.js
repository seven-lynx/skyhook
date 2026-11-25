/**
 * api-server.js — HTTP JSON API over the seeder engine.
 *
 * This is the centralisation layer: the Windows/Pi web GUI (served from / via
 * src/gui/), a browser, or curl can drive seeding over the LAN with no SSH.
 * Zero framework — Node's built-in http server. CORS is open so the GUI (any
 * origin) can call it.
 *
 * The route table is `docs/api.md` (the contract) and the `if (method === ...)`
 * chain below (what serves it). This header used to list a subset of the routes
 * and drifted from both; do not restate them here.
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
import { pipelineStatus, startPipelineJob, isLlmKind } from "./pipeline.js";
import { nodeId, getConfig } from "../config.js";
import {
  routeSeeders, peerFor, runRemote, forwardSchedule, remoteToken, acceptedTokens,
} from "../core/remote.js";
import { loadSettings, saveSettings, settingsView, allowRemote, getActiveTaggingProvider } from "../core/settings.js";
import { readStaged } from "../core/staged.js";
import { mergeRemoteRows, pushStagedToStorage } from "../core/sync.js";
import { statsFromStaged } from "../core/analytics.js";
import { listCache, pruneStaged, clearDiscovery, clearStaged } from "../core/data.js";
import { countMissingSync, getTasks } from "../adapters/tagging/tasks.js";
import { detectModels, ensureModelLoaded } from "../adapters/tagging/index.js";

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
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
}

/** A body the handler must not see; the request listener answers it. */
class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Read and parse a JSON request body.
 *
 * A body past the limit is drained and rejected, never `req.destroy()`ed:
 * destroying the socket means `end` never fires, so the promise never settles
 * and the handler waits forever with nothing in the log. Rejecting with a
 * `BodyError` lets the one catch in the request listener answer 413/400.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let over = false;
    req.on("data", (d) => {
      if (over) return; // keep draining so the client is not left hanging
      body += d;
      if (body.length > 1e6) { over = true; body = ""; }
    });
    req.on("end", () => {
      if (over) return reject(new BodyError(413, "request body too large"));
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new BodyError(400, "request body is not valid JSON")); }
    });
    req.on("error", () => reject(new BodyError(400, "request body could not be read")));
  });
}

function seederView(s, st) {
  const lastResult = st?.last_result ? JSON.parse(st.last_result) : null;
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
    lastResult,
    lastStaged: lastResult ? (lastResult.staged ?? 0) : null,
    lastDurationMs: st?.last_duration_ms ?? null,
    lastError: st?.last_error ?? null,
    nextRunAt: st?.next_run_at ?? null,
  };
}

/** The addresses that can only be reached from this machine. */
export function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Listen on `host` — loopback unless the operator asks for more.
 *
 * A non-loopback bind is opt-in and needs the shared token: GETs are
 * unauthenticated (`docs/api.md`, Auth), so without one the read API and every
 * POST route answer anyone who can reach the port. This is a refusal rather
 * than a warning, because a warning leaves the hole open.
 */
export function startServer(port = 4173, { host = "127.0.0.1" } = {}) {
  if (!isLoopbackHost(host) && !remoteToken()) {
    throw new Error(
      `refusing to listen on ${host} with no API token — set SKYHOOK_REMOTE_TOKEN `
      + "(or remote.token in skyhook.config.json), or bind 127.0.0.1",
    );
  }
  const db = openState();
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    try {
      // Token gate on all mutating requests: the shared secret across PC/Pi, or the
      // per-launch token the desktop shell generated for its own window.
      if (method === "POST") {
        const tokens = acceptedTokens();
        if (tokens.length) {
          const h = req.headers.authorization || "";
          const provided = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-skyhook-token"] || "");
          if (!tokens.includes(provided)) return send(res, 403, { error: "invalid or missing token" });
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
        // The executable path and the base URL decide what `spawn` runs
        // (`src/core/cloudflare.js`), so they are static-config only: a
        // settings toggle must never become a process-launch primitive.
        for (const key of ["exePath", "url"]) {
          if (body.flaresolverr && body.flaresolverr[key] !== undefined) {
            return send(res, 400, {
              error: `flaresolverr.${key} is set in skyhook.config.json, not over the API`,
            });
          }
        }
        const patch = {};
        if (typeof body.allowRemote === "boolean") patch.allowRemote = body.allowRemote;
        if (typeof body.taggingPlatform === "string") patch.taggingPlatform = body.taggingPlatform;
        if (body.flaresolverr && typeof body.flaresolverr === "object") {
          patch.flaresolverr = {
            enabled: typeof body.flaresolverr.enabled === "boolean" ? body.flaresolverr.enabled : undefined,
            port: body.flaresolverr.port != null ? parseInt(body.flaresolverr.port, 10) || 8191 : undefined,
            maxTimeout: body.flaresolverr.maxTimeout != null ? parseInt(body.flaresolverr.maxTimeout, 10) || 60000 : undefined,
          };
          for (const k of Object.keys(patch.flaresolverr)) {
            if (patch.flaresolverr[k] === undefined) delete patch.flaresolverr[k];
          }
        }
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
      // ── tagging task definitions (config-driven) ───────────────────────
      if (method === "GET" && path === "/api/tagging/tasks") {
        const tasks = getTasks().map((t) => ({
          key: t.key, label: t.label, target: t.target ?? null,
          gap: t.gap ?? null, reprocess: !!t.reprocess,
          minTags: t.minTags ?? null,
        }));
        return send(res, 200, { tasks });
      }

      // ── tagging models (probe the active provider) ────────────────────
      if (method === "GET" && path === "/api/tagging/models") {
        const c = getConfig();
        const provider = getActiveTaggingProvider();
        const { models, errors } = await detectModels(provider ? [provider] : (c.tagging?.providers || []));
        return send(res, 200, { models, errors, configured: c.tagging?.model ?? null, provider: provider?.id ?? null });
      }

      // ── load a model into memory (LM Studio) before tagging ──────────
      if (method === "POST" && path === "/api/tagging/models/load") {
        const body = await readBody(req);
        const modelId = (body.model || "").trim();
        if (!modelId) return send(res, 400, { error: "model is required" });
        const c = getConfig();
        const provider = (body.provider?.trim())
          ? (c.tagging?.providers || []).find((p) => p.id === body.provider.trim())
          : getActiveTaggingProvider();
        if (!provider) return send(res, 400, { error: "No active tagging provider configured" });
        const result = await ensureModelLoaded(provider, modelId);
        if (result.error) return send(res, 502, result);
        return send(res, 200, result);
      }

      if (method === "POST" && path === "/api/tagging/run") {
        const body = await readBody(req);
        const taskKey = (body.task || "").trim();
        if (!taskKey) return send(res, 400, { error: "task is required" });
        const c = getConfig();
        if (!c.pipeline?.offlineDb) return send(res, 400, { error: "pipeline.offlineDb not configured" });
        const jobKey = `task:${taskKey}`;
        if (listRunning().some((r) => r.source === jobKey)) {
          return send(res, 409, { error: `${jobKey} already running` });
        }
        if (listRunning().some((r) => isLlmKind(r.source))) {
          return send(res, 409, { error: "another LLM worker is already running" });
        }
        // Launch via runJob — the task worker runs as a CLI subprocess so it
        // shows up in the live-log drawer with its own tab.
        const skyhookPath = join(__dirname, "..", "..", "bin", "skyhook.js");
        const args = ["tag", "--task", taskKey];
        const model = (body.model || "").trim();
        const provider = (body.provider || "").trim();
        const minTags = parseInt(body.minTags, 10);

        // If a specific model was chosen, ensure it's loaded before tagging
        // (ejects any other loaded model, then loads ours — no double instances).
        if (model) {
          const targetProvider = provider
            ? (c.tagging?.providers || []).find((p) => p.id === provider)
            : getActiveTaggingProvider();
          if (targetProvider) {
            const loadState = await ensureModelLoaded(targetProvider, model);
            if (loadState.error) return send(res, 502, { error: loadState.error });
          }
        }

        if (model) args.push("--model", model);
        if (provider) args.push("--provider", provider);
        if (Number.isFinite(minTags) && minTags > 0) args.push("--min-tags", String(minTags));
        runJob({ key: jobKey, scriptPath: skyhookPath, args })
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
      if (err instanceof BodyError) return send(res, err.status, { error: err.message });
      return send(res, 500, { error: err.message });
    }
  });

  server.listen(port, host, () => {
    // `port` is what the caller asked for. With `--port 0` — `skyhook app`'s default — the
    // bound one is only known here, and a banner naming `:0` sends the reader to a dead URL (#17).
    const bound = server.address()?.port ?? port;
    const shown = host.includes(":") ? `[${host}]` : host;
    const reach = isLoopbackHost(host) ? "loopback only" : "reachable on the network";
    console.log(`\n🛰  Skyhook seeder API listening on http://${shown}:${bound} (${reach})`);
    console.log(`   GUI:  http://${shown}:${bound}/`);
    console.log(`   API:  http://${shown}:${bound}/api/health\n`);
  });

  // This function opens the state DB, so it is also where the handle is
  // released. Windows refuses to delete an open file, so a caller that closes
  // the listener (a test, or a future in-process restart) would otherwise leave
  // `.tmp-*` state behind it.
  server.on("close", () => {
    try { db.close(); } catch {} // already closed — nothing to release
  });

  return server;
}
