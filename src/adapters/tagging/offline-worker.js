/**
 * offline-worker.js â€” offline LLM tagging worker over a local SQLite DB.
 *
 * Migrated from Roam's scripts/tagging-worker.mjs. It tags a local export of
 * URLs using a locally-loaded LLM (LM Studio / any OpenAI-compatible endpoint),
 * and resumes via a `local_url_tagged_by` marker table (already-tagged URLs are
 * excluded on the next run). Second-pass modes let you re-tag already-tagged
 * URLs to add more tags (`retag-add`) or replace them (`retag-replace`).
 *
 * Task-driven mode (--task <key>) targets a specific gap: missing categories,
 * subcategories, tags, content types, quality, or attributes. Each task has its
 * own prompt, URL filter, parse logic, and write target.
 */
import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { loadText } from "./index.js";
import { canonicalizeTagList } from "./canonicalize.js";
import { getTask, loadTaskPromptFile, buildTaskUserMessage, parseTaskResponse } from "./tasks.js";

// â”€â”€ Validation enums (what the LLM is allowed to emit) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const VALID_URL_TYPES = new Set([
  "article", "reference", "interactive", "gallery", "product-page",
  "landing-page", "domain-parking", "login-wall", "error-page",
  "spam", "thin-content", "other",
]);
const VALID_AUDIENCE = new Set(["beginner", "intermediate", "advanced", "general"]);
const VALID_CONTENT_TYPE = new Set([
  "article", "research", "tutorial", "review", "opinion", "news",
  "reference", "gallery", "interactive", "other",
]);
const VALID_DEPTH = new Set(["quick-read", "medium", "deep-dive", "reference"]);

const TAG_LOCK_STALE_MS = 15 * 60 * 1000;

function acquireTagLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs >= TAG_LOCK_STALE_MS; } catch { stale = true; }
      if (!stale) throw new Error("another tagger is already running (lock file is fresh)");
      try { unlinkSync(lockPath); } catch {}
    }
  }
  throw new Error("could not acquire tagger lock");
}

function releaseTagLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

/** Load a system prompt, extracting the "## System Prompt" section if present. */
export function loadPrompt(file) {
  const raw = loadText(file);
  if (!raw) return null;
  const marker = "## System Prompt";
  const idx = raw.indexOf(marker);
  return (idx === -1 ? raw : raw.slice(idx + marker.length)).trim();
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_url_tags (
      url_id TEXT NOT NULL, tag_slug TEXT NOT NULL, confidence REAL NOT NULL,
      source TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_url_tagged_by (
      url_id TEXT NOT NULL, model_source TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (url_id, model_source)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_local_url_tagged_by_model ON local_url_tagged_by(model_source)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_url_attributes (
      url_id TEXT PRIMARY KEY, audience_level TEXT, content_type TEXT, depth TEXT,
      tone TEXT, is_news INTEGER, confidence REAL, created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_url_quality (
      url_id TEXT PRIMARY KEY, url_type TEXT, quality_score REAL,
      is_parked INTEGER, is_product INTEGER, is_spam INTEGER, is_paywalled INTEGER,
      is_login_required INTEGER, is_broken INTEGER, is_thin INTEGER, is_clickbait INTEGER,
      is_english INTEGER, confidence REAL, created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_tagging_progress (
      id INTEGER PRIMARY KEY, tier INTEGER DEFAULT 0, last_url_id TEXT,
      total_processed INTEGER DEFAULT 0, total_failed INTEGER DEFAULT 0,
      total_skipped INTEGER DEFAULT 0, rate_per_hour REAL,
      started_at TEXT, updated_at TEXT, status TEXT DEFAULT 'idle'
    )
  `);
  // Older offline DBs may lack rate_per_hour.
  try {
    const cols = db.prepare("PRAGMA table_info(local_tagging_progress)").all().map((r) => r.name);
    if (!cols.includes("rate_per_hour")) db.exec("ALTER TABLE local_tagging_progress ADD COLUMN rate_per_hour REAL");
  } catch { /* ignore */ }
}

function buildUserMessage(urls) {
  let msg = "Tag the following URLs. For each, provide tags, attributes, and quality assessment.\n\n";
  urls.forEach((u, i) => {
    msg += `[URL ${i}]\n`;
    msg += `Title: ${u.title || ""}\n`;
    msg += `Description: ${u.description || ""}\n\n`;
  });
  return msg;
}

async function callLLM({ provider, model, systemPrompt, userMessage }) {
  const isOllama = provider?.id === "ollama";
  const endpoint = isOllama ? `${provider.baseUrl}/api/chat` : `${provider.baseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (provider?.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const makeBody = (sys, usr) => {
    if (isOllama) {
      const merged = sys ? `${sys}\n\n---\n\n${usr}` : usr;
      return { model, messages: [{ role: "user", content: merged }], stream: false, format: "json", options: { temperature: 0 } };
    }
    const messages = sys ? [{ role: "system", content: sys }, { role: "user", content: usr }] : [{ role: "user", content: usr }];
    return { model, messages, temperature: 0, max_tokens: 16384 };
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let res = await fetch(endpoint, {
        method: "POST", headers, body: JSON.stringify(makeBody(systemPrompt, userMessage)),
        signal: AbortSignal.timeout(900000),
      });

      if (res.status === 400) {
        const errText = await res.text().catch(() => "");
        if (errText.includes("system") || errText.includes("Only user")) {
          // Model refuses a system role â€” merge into a single user message.
          res = await fetch(endpoint, {
            method: "POST", headers, body: JSON.stringify(makeBody(null, `${systemPrompt}\n\n---\n\n${userMessage}`)),
            signal: AbortSignal.timeout(900000),
          });
        } else {
          throw new Error(`HTTP 400: ${errText.slice(0, 200)}`);
        }
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const content = isOllama ? data?.message?.content : data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty response content");
      return content;
    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.code === "ABORT_ERR" || /timed out|aborted/i.test(err.message || "");
      if (isTimeout || attempt === 5) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`  Retry ${attempt}/5 after ${delay / 1000}s: ${err.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function extractJson(text) {
  const t = String(text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return body.slice(start, end + 1);
}

function parseResponse(raw, urlCount, validTags) {
  const parsed = JSON.parse(extractJson(raw));
  const results = [];
  const urlResults = Array.isArray(parsed.results) ? parsed.results : (Array.isArray(parsed) ? parsed : []);

  for (const r of urlResults) {
    const idx = r.url_index;
    if (idx === undefined || idx >= urlCount) continue;

    const tags = canonicalizeTagList(r.tags, validTags, (from, to) => {
      console.warn(`  â†ª  tag "${from}" â†’ "${to}"`);
    });

    const attrs = r.attributes || {};
    const audience = VALID_AUDIENCE.has(attrs.audience_level) ? attrs.audience_level : "general";
    const contentType = VALID_CONTENT_TYPE.has(attrs.content_type) ? attrs.content_type : "other";
    const depth = VALID_DEPTH.has(attrs.depth) ? attrs.depth : "medium";
    const tone = Array.isArray(attrs.tone) ? JSON.stringify(attrs.tone) : "[]";
    const isNews = attrs.is_news ? 1 : 0;

    const quality = r.quality || {};
    const urlType = VALID_URL_TYPES.has(quality.url_type) ? quality.url_type : "other";
    const qScore = typeof quality.quality_score === "number"
      ? Math.max(0, Math.min(10, Math.round(quality.quality_score)))
      : 5;
    const flags = quality.flags || {};

    results.push({
      url_index: idx,
      tags,
      attributes: { audience_level: audience, content_type: contentType, depth, tone, is_news: isNews },
      quality: {
        url_type: urlType, quality_score: qScore,
        is_parked: flags.is_parked ? 1 : 0, is_product: flags.is_product ? 1 : 0,
        is_spam: flags.is_spam ? 1 : 0, is_paywalled: flags.is_paywalled ? 1 : 0,
        is_login_required: flags.is_login_required ? 1 : 0, is_broken: flags.is_broken ? 1 : 0,
        is_thin: flags.is_thin ? 1 : 0, is_clickbait: flags.is_clickbait ? 1 : 0,
        is_english: flags.is_english ? 1 : 0,
      },
    });
  }
  return results;
}

/**
 * Run the offline tagging worker to completion (or until stopped).
 *
 * @param {object} opts
 * @param {string} opts.dbPath      local SQLite DB (pipeline.offlineDb)
 * @param {object} opts.provider    tagging provider { id, baseUrl, apiKey }
 * @param {string} opts.model       model id
 * @param {string} opts.prompt      system prompt text
 * @param {string[]} [opts.validTags] canonical tag slugs (else loaded from local_tags)
 * @param {string} [opts.modelSource] marker for "tagged by this run" (default "llm")
 * @param {number} [opts.batchSize]
 * @param {number} [opts.max]       stop after this many URLs
 * @param {"tag"|"retag-add"|"retag-replace"} [opts.mode]
 * @param {number} [opts.tier]
 */
export async function runOfflineTagWorker(opts = {}) {
  const {
    dbPath, provider, model, prompt,
    validTags = null, modelSource = "llm", batchSize = 25, max = null,
    mode = "tag", tier = 0, task: taskKey = null, logFile = null, minTags = null,
  } = opts;

  // Tee console output to a persistent log file so the GUI can show the
  // worker's log even when it isn't launched through the server's runJob.
  if (logFile) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      const line = (a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
      const out = console.log, errOut = console.error;
      console.log = (...a) => { out(...a); try { appendFileSync(logFile, line(a), "utf8"); } catch {} };
      console.error = (...a) => { errOut(...a); try { appendFileSync(logFile, line(a), "utf8"); } catch {} };
    } catch { /* best-effort logging */ }
  }

  if (!dbPath) throw new Error("offline tagging worker needs pipeline.offlineDb");
  if (!existsSync(dbPath)) throw new Error(`Offline DB not found: ${dbPath}`);
  if (!provider?.baseUrl) throw new Error("offline tagging worker needs tagging.providers[].baseUrl");
  if (!model) throw new Error("offline tagging worker needs tagging.model");
  if (!prompt) throw new Error("offline tagging worker needs a system prompt (tagging.promptFile)");

  // Resolve task (if --task was given). Task mode overrides the default prompt + mode.
  const task = taskKey ? getTask(taskKey) : null;
  if (taskKey && !task) throw new Error(`Unknown task: ${taskKey}`);
  if (task) console.log(`Task: ${task.label} (target: ${task.target})`);

  // Single-instance guard: only one LLM worker may run against this DB at a
  // time. The lock file also covers CLI launches the server can't see, and a
  // stale lock (crashed worker) is reclaimed.
  const lockPath = join(dirname(dbPath), ".tagger.lock");
  let lockHeld = false;
  acquireTagLock(lockPath);
  lockHeld = true;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = OFF");

  ensureTables(db);

  const tagSlugs = (validTags && validTags.length)
    ? validTags
    : (() => { try { return db.prepare("SELECT slug FROM local_tags WHERE is_active = 1").all().map((r) => r.slug); } catch { return []; } })();

  const taskActive = task && taskKey;
  const resolvedPrompt = taskActive ? (loadTaskPromptFile(task) || prompt) : prompt;
  const resolvedModelSource = taskActive ? task.resumeSource : modelSource;

  const reprocess = mode === "retag-add" || mode === "retag-replace" || (taskActive && task.reprocess === true);
  const taggedFilter = reprocess
    ? ""
    : `AND u.id NOT IN (SELECT url_id FROM local_url_tagged_by WHERE model_source IN ('${resolvedModelSource}', '${resolvedModelSource}:failed'))`;
  const taskFilter = taskActive ? (task.filterClause || "") : "";
  const resolvedMinTags = minTags ?? (taskActive && task.minTags != null ? Number(task.minTags) : null);
  const minTagsFilter = (resolvedMinTags != null && resolvedMinTags > 0)
    ? `AND (u.id NOT IN (SELECT url_id FROM local_url_tags) OR (SELECT COUNT(*) FROM local_url_tags t WHERE t.url_id = u.id) < ${resolvedMinTags})`
    : "";
  const URL_QUERY = `
    SELECT u.id, u.title, u.description, u.url
    FROM urls u
    WHERE u.approved = 1 AND u.inactive = 0
      AND u.title IS NOT NULL AND u.title != ''
      ${taggedFilter}
      ${taskFilter}
      ${minTagsFilter}
    ORDER BY u.id
  `;

  const insertTag = db.prepare(`INSERT OR IGNORE INTO local_url_tags (url_id, tag_slug, confidence, source) VALUES (?, ?, ?, ?)`);
  const insertTaggedBy = db.prepare(`INSERT OR IGNORE INTO local_url_tagged_by (url_id, model_source) VALUES (?, ?)`);
  const deleteTagsFor = db.prepare(`DELETE FROM local_url_tags WHERE url_id = ? AND source = ?`);
  const insertAttr = db.prepare(`INSERT OR REPLACE INTO local_url_attributes (url_id, audience_level, content_type, depth, tone, is_news, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Targeted attribute writes so gap-fill tasks don't clobber each other's
  // columns (INSERT OR REPLACE nulls any column a task isn't filling).
  const ensureAttr = db.prepare(`INSERT OR IGNORE INTO local_url_attributes (url_id) VALUES (?)`);
  const updateContentType = db.prepare(`UPDATE local_url_attributes SET content_type = ?, confidence = ? WHERE url_id = ?`);
  const updateAttributes = db.prepare(`UPDATE local_url_attributes SET audience_level = ?, depth = ?, tone = ?, is_news = ?, confidence = ? WHERE url_id = ?`);
  const insertQuality = db.prepare(`INSERT OR REPLACE INTO local_url_quality (url_id, url_type, quality_score, is_parked, is_product, is_spam, is_paywalled, is_login_required, is_broken, is_thin, is_clickbait, is_english, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
// Task-specific write helpers.
  const updateCategory = db.prepare(`UPDATE urls SET category_id = ? WHERE id = ?`);
  const updateSubcategory = db.prepare(`UPDATE urls SET subcategory_id = ? WHERE id = ?`);
  const updateProgress = db.prepare(`
    INSERT INTO local_tagging_progress (id, tier, last_url_id, total_processed, total_failed, total_skipped, rate_per_hour, started_at, updated_at, status)
    VALUES (1, ?, ?, ?, ?, ?, ?, COALESCE((SELECT started_at FROM local_tagging_progress WHERE id = 1), datetime('now')), datetime('now'), 'running')
    ON CONFLICT(id) DO UPDATE SET
      tier = excluded.tier, last_url_id = excluded.last_url_id,
      total_processed = excluded.total_processed, total_failed = excluded.total_failed,
      total_skipped = excluded.total_skipped, rate_per_hour = excluded.rate_per_hour,
      started_at = COALESCE(local_tagging_progress.started_at, excluded.started_at),
      updated_at = datetime('now'), status = 'running'
  `);

  let cp = db.prepare("SELECT * FROM local_tagging_progress WHERE id = 1").get();
  if (!cp) {
    db.prepare("INSERT INTO local_tagging_progress (id, tier, total_processed, total_failed, total_skipped, status) VALUES (1, 0, 0, 0, 0, 'idle')").run();
    cp = db.prepare("SELECT * FROM local_tagging_progress WHERE id = 1").get();
  }

  let totalProcessed = cp.total_processed;
  let totalFailed = cp.total_failed;
  let totalSkipped = cp.total_skipped;
  let ratePerHour = cp.rate_per_hour ?? null;

  const totalEligible = db.prepare(`SELECT COUNT(*) AS c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != ''`).get().c;
  let done = db.prepare(`SELECT COUNT(*) AS c FROM local_url_tagged_by WHERE model_source = ?`).get(modelSource).c;
  const totalRemaining = db.prepare(`SELECT COUNT(*) AS c FROM (${URL_QUERY})`).get().c;

  console.log(`\nOffline tagging worker`);
  console.log(`  mode: ${mode}  model: ${model}  source: ${modelSource}`);
  console.log(`  remaining: ${totalRemaining.toLocaleString()} / ${totalEligible.toLocaleString()} eligible`);
  console.log(`  checkpoint: ${totalProcessed.toLocaleString()} processed, ${totalFailed.toLocaleString()} failed\n`);

  updateProgress.run(tier, cp.last_url_id ?? null, totalProcessed, totalFailed, totalSkipped, ratePerHour);

  let shuttingDown = false;
  const cleanup = () => { try { if (lockHeld) releaseTagLock(lockPath); } catch {} try { db.close(); } catch {} };
  process.on("SIGINT", () => {
    if (shuttingDown) { cleanup(); process.exit(1); }
    shuttingDown = true;
    console.log("\n\nðŸ›‘ SIGINT received. Finishing current batch...");
  });
  process.on("exit", cleanup);

  let batchCount = 0;
  let consecutiveFailures = 0;
  while (true) {
    if (shuttingDown) break;
    if (max && totalProcessed >= max) break;

    const limit = max ? Math.min(batchSize, max - totalProcessed) : batchSize;
    const urls = db.prepare(`${URL_QUERY} LIMIT ${limit}`).all();
    if (urls.length === 0) { console.log("\nâœ… No more URLs to process."); break; }

    const batchStart = Date.now();
    batchCount++;
    try {
      const userMessage = taskActive
        ? buildTaskUserMessage(urls, task)
        : buildUserMessage(urls);
      const rawResponse = await callLLM({ provider, model, systemPrompt: resolvedPrompt, userMessage });
      const parsed = taskActive
        ? parseTaskResponse(rawResponse, urls.length, task)
        : parseResponse(rawResponse, urls.length, tagSlugs);

      db.transaction(() => {
        for (const u of urls) {
          if (mode === "retag-replace") deleteTagsFor.run(u.id, resolvedModelSource);
          insertTaggedBy.run(u.id, resolvedModelSource);
        }
        if (taskActive) {
          // Task-specific write logic.
          for (const r of parsed) {
            const url = urls[r.url_index];
            if (!url) continue;
            switch (task.target) {
              case "category":
                if (r.category && r.category !== "UNKNOWN") updateCategory.run(r.category, url.id);
                break;
              case "subcategory":
                if (r.subcategory && r.subcategory !== "UNKNOWN") updateSubcategory.run(r.subcategory, url.id);
                break;
              case "tags":
                for (const t of (r.tags || [])) {
                  if (t.slug && t.slug !== "none") insertTag.run(url.id, t.slug, typeof t.confidence === "number" ? t.confidence : 0.7, resolvedModelSource);
                }
                break;
              case "contentType":
                ensureAttr.run(url.id);
                updateContentType.run(r.contentType, r.confidence ?? 0.5, url.id);
                break;
              case "quality":
                insertQuality.run(url.id, r.url_type, r.quality_score,
                  r.is_parked ? 1 : 0, r.is_product ? 1 : 0, r.is_spam ? 1 : 0,
                  r.is_paywalled ? 1 : 0, r.is_login_required ? 1 : 0,
                  r.is_broken ? 1 : 0, r.is_thin ? 1 : 0, r.is_clickbait ? 1 : 0,
                  r.is_english ? 1 : 0, r.confidence ?? 0.5);
                break;
              case "attributes":
                ensureAttr.run(url.id);
                updateAttributes.run(r.audience_level, r.depth, r.tone, r.is_news ? 1 : 0, r.confidence ?? 0.5, url.id);
                break;
            }
          }
        } else {
          for (const r of parsed) {
            const url = urls[r.url_index];
            if (!url) continue;
            for (const t of r.tags) insertTag.run(url.id, t.slug, t.confidence, resolvedModelSource);
            insertAttr.run(url.id, r.attributes.audience_level, r.attributes.content_type, r.attributes.depth, r.attributes.tone, r.attributes.is_news, 1.0);
            const q = r.quality;
            insertQuality.run(url.id, q.url_type, q.quality_score, q.is_parked, q.is_product, q.is_spam, q.is_paywalled, q.is_login_required, q.is_broken, q.is_thin, q.is_clickbait, q.is_english, 1.0);
          }
        }
      })();

      consecutiveFailures = 0;
      totalProcessed += urls.length;
      done += urls.length;
      const lastUrl = urls[urls.length - 1];
      const instantRate = urls.length / ((Date.now() - batchStart) / 3600000);
      ratePerHour = ratePerHour ? ratePerHour * 0.8 + instantRate * 0.2 : instantRate;
      const pct = totalEligible > 0 ? ((done / totalEligible) * 100).toFixed(2) : "?";
      console.log(`${done.toLocaleString()}/${totalEligible.toLocaleString()} (${pct}%) | ~${Math.round(ratePerHour).toLocaleString()}/hr | last: ${String(lastUrl.id).slice(0, 8)}`);
      updateProgress.run(tier, lastUrl.id, totalProcessed, totalFailed, totalSkipped, ratePerHour);
    } catch (err) {
      consecutiveFailures++;
      console.error(`\nâŒ Batch ${batchCount} failed (${consecutiveFailures} consecutive): ${err.message}`);
      db.transaction(() => {
        for (const u of urls) insertTaggedBy.run(u.id, `${resolvedModelSource}:failed`);
      })();
      totalFailed += urls.length;
      totalSkipped += urls.length;
      totalProcessed += urls.length;
      updateProgress.run(tier, cp.last_url_id ?? null, totalProcessed, totalFailed, totalSkipped, ratePerHour);
      if (/Model unloaded/i.test(err.message) || consecutiveFailures >= 5) {
        console.error(`\nâ¸ï¸  Pausing â€” model may have unloaded. Check LM Studio.`);
        shuttingDown = true;
      }
    }
  }

  const finalStatus = shuttingDown ? "paused" : "done";
  db.prepare(`UPDATE local_tagging_progress SET status = ?, updated_at = datetime('now'), total_processed = ?, total_failed = ?, total_skipped = ? WHERE id = 1`)
    .run(finalStatus, totalProcessed, totalFailed, totalSkipped);
  console.log(`\n${finalStatus === "done" ? "âœ… Complete" : "â¸ï¸  Paused"} â€” ${totalProcessed.toLocaleString()} processed, ${totalFailed.toLocaleString()} failed`);
  cleanup();
  return { status: finalStatus, processed: totalProcessed, failed: totalFailed, skipped: totalSkipped };
}