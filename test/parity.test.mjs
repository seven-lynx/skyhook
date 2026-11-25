import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { enumTable } from "../src/adapters/tagging/enums.js";
import { parseTaskResponse } from "../src/adapters/tagging/tasks.js";
import { runOfflineTagWorker } from "../src/adapters/tagging/offline-worker.js";
import { uploadTagRows } from "../src/core/offline-pipeline.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function quiet() {
  const log = console.log, err = console.error, warn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  return () => { console.log = log; console.error = err; console.warn = warn; };
}

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "skyhook-parity-"));
  return { dir, path: join(dir, "offline.db") };
}

function seedUrls(dbPath, rows) {
  const db = new Database(dbPath);
  // Mirrors the real offline schema: the worker prepares UPDATEs against the
  // category columns at start-up, so they must exist even when unused.
  db.exec(`CREATE TABLE urls (
    id TEXT PRIMARY KEY, url TEXT, title TEXT, description TEXT,
    category_id TEXT, subcategory_id TEXT,
    approved INTEGER DEFAULT 1, inactive INTEGER DEFAULT 0
  )`);
  const stmt = db.prepare("INSERT INTO urls (id, url, title, description, approved, inactive) VALUES (?, ?, ?, ?, 1, 0)");
  for (const r of rows) stmt.run(r.id, r.url, r.title ?? "Title", r.description ?? "Description");
  db.close();
}

/** A provider that answers only the indexes the test lists. */
function stubProvider(answerIndexes) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      results: answerIndexes.map((i) => ({
        url_index: i,
        tags: [{ slug: "news", confidence: 0.9 }],
        attributes: { audience_level: "advanced", content_type: "article", depth: "medium", tone: ["formal"], is_news: false },
        quality: { url_type: "article", quality_score: 8, flags: { is_english: true } },
      })),
    }) } }] }),
  });
  return () => { globalThis.fetch = original; };
}

function provider() {
  return { id: "openai", baseUrl: "https://example.invalid/v1", apiKey: null };
}

test("the four local VALID_* sets are gone; the vocabulary comes from config", () => {
  const src = readFileSync(join(root, "src", "adapters", "tagging", "offline-worker.js"), "utf8");
  assert.ok(!/VALID_(URL_TYPES|AUDIENCE|CONTENT_TYPE|DEPTH)/.test(src));
  const table = enumTable();
  assert.ok(Array.isArray(table.values.tone));
  assert.ok(table.arrays.includes("tone"));
});

test("every word a shipped task prompt names is accepted by the enum table", () => {
  const table = enumTable();
  const attrs = readFileSync(join(root, "config", "prompts", "fill-attributes.md"), "utf8");
  for (const word of ["beginner", "intermediate", "advanced", "general", "article", "other",
    "quick-read", "medium", "deep-dive", "academic", "technical", "accessible",
    "conversational", "journalistic", "humorous", "critical", "inspirational",
    "neutral", "sensational"]) {
    assert.ok(attrs.includes(word), `fill-attributes.md should name ${word}`);
  }
  assert.ok(!/formal|persuasive/.test(attrs), "fill-attributes.md still names a tone word the writer would reject");
  for (const word of ["academic", "technical", "accessible", "conversational", "journalistic",
    "humorous", "critical", "inspirational", "neutral", "sensational"]) {
    assert.ok(table.values.tone.includes(word), `tagging.enums.tone should accept ${word}`);
  }
  const quality = readFileSync(join(root, "config", "prompts", "fill-quality.md"), "utf8");
  assert.ok(/0 to 10/.test(quality), "fill-quality.md should ask for the 0-10 scale");
});

test("a tags task parses the attributes and quality from the same response", () => {
  const raw = JSON.stringify({ results: [{
    url_index: 0,
    tags: [{ slug: "news", confidence: 0.8 }],
    attributes: { audience_level: "advanced", content_type: "article", depth: "medium", tone: ["formal"], is_news: false },
    quality: { url_type: "article", quality_score: 8, flags: { is_english: true } },
  }] });
  const out = parseTaskResponse(raw, 1, { target: "tags" }, enumTable());
  assert.deepEqual(out[0].tags, [{ slug: "news", confidence: 0.8 }]);
  // `formal` is not a target value; the configured alias maps it to `serious`.
  assert.deepEqual(out[0].attributes.tone, ["serious"]);
  assert.equal(out[0].quality.quality_score, 8);
});

test("--requeue-untagged re-selects a zero-tag URL that has a marker, and skips junk", async () => {
  const { dir, path } = tmpDb();
  const restoreLogs = quiet();
  seedUrls(path, [
    { id: "u1", url: "https://a.com/1" },
    { id: "u2", url: "https://a.com/2" },
  ]);
  // Both were "tagged" by an older pass: markers exist, tags do not.
  const seed = new Database(path);
  seed.exec(`CREATE TABLE local_url_tagged_by (url_id TEXT NOT NULL, model_source TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (url_id, model_source))`);
  seed.prepare("INSERT INTO local_url_tagged_by (url_id, model_source) VALUES (?, 'llm')").run("u1");
  seed.prepare("INSERT INTO local_url_tagged_by (url_id, model_source) VALUES (?, 'llm')").run("u2");
  seed.exec(`CREATE TABLE local_url_quality (url_id TEXT PRIMARY KEY, url_type TEXT, quality_score REAL,
             is_parked INTEGER, is_product INTEGER, is_spam INTEGER, is_paywalled INTEGER,
             is_login_required INTEGER, is_broken INTEGER, is_thin INTEGER, is_clickbait INTEGER,
             is_english INTEGER, confidence REAL, created_at TEXT)`);
  seed.prepare("INSERT INTO local_url_quality (url_id, quality_score, is_parked) VALUES ('u2', 8, 1)").run();
  seed.close();

  const restoreFetch = stubProvider([0]);
  try {
    await runOfflineTagWorker({
      dbPath: path, provider: provider(), model: "m", prompt: "Classify.",
      validTags: ["news"], batchSize: 5, max: 5, requeueUntagged: true,
    });
  } finally {
    restoreFetch();
    restoreLogs();
  }
  const db = new Database(path, { readonly: true });
  const tagged = db.prepare("SELECT url_id FROM local_url_tags ORDER BY url_id").all().map((r) => r.url_id);
  const markers = db.prepare("SELECT COUNT(*) c FROM local_url_tagged_by").get().c;
  db.close();

  assert.deepEqual(tagged, ["u1"], "only the non-junk zero-tag URL is re-tagged");
  assert.equal(markers, 2, "marker rows are never deleted, so resume history survives");
  rmSync(dir, { recursive: true, force: true });
});

test("the upload cursor pages 1,000 unsynced rows in one pass, then 0", async () => {
  const { dir, path } = tmpDb();
  const db = new Database(path);
  db.exec(`CREATE TABLE local_url_tags (url_id TEXT NOT NULL, tag_slug TEXT NOT NULL,
           confidence REAL NOT NULL, source TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
           synced INTEGER DEFAULT 0)`);
  const ins = db.prepare("INSERT INTO local_url_tags (url_id, tag_slug, confidence, source) VALUES (?, 'news', 0.9, 'llm:qwen')");
  db.transaction(() => { for (let i = 0; i < 1000; i++) ins.run(`u${i}`); })();

  const sent = [];
  const sb = {
    from(table) {
      return {
        select: async () => ({ data: table === "tags" ? [{ id: "t-news", slug: "news" }] : [], error: null }),
        upsert: async (rows) => { sent.push(...rows); return { error: null }; },
      };
    },
  };

  const first = await uploadTagRows(sb, db, { batchSize: 100, uploadSource: "llm" });
  assert.equal(first.uploaded, 1000, "one pass must upload every unsynced row");
  assert.equal(sent.length, 1000);
  assert.ok(sent.every((r) => r.source === "llm"), "source is normalised, not the local per-model value");

  const second = await uploadTagRows(sb, db, { batchSize: 100, uploadSource: "llm" });
  assert.equal(second.uploaded, 0, "a second pass uploads nothing");

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a config-declared tag job is recognised as an LLM job", async () => {
  const { isLlmKind } = await import("../src/interfaces/pipeline.js");
  const cfg = getConfig();
  const before = cfg.pipeline.jobs;
  cfg.pipeline.jobs = {
    "tag-retry-failed": { label: "Retry failed", command: ["bin/skyhook.js", "tag", "--retry-failed"] },
    "export": { label: "Pull", command: ["bin/skyhook.js", "pull"] },
    "declared": { label: "Declared", command: ["other.js"], llm: true },
  };
  try {
    assert.equal(isLlmKind("tag-retry-failed"), true);
    assert.equal(isLlmKind("export"), false);
    assert.equal(isLlmKind("declared"), true);
  } finally {
    cfg.pipeline.jobs = before;
  }
});

test("the retry and requeue buttons exist with no config at all", async () => {
  const { jobSpec } = await import("../src/interfaces/pipeline.js");
  const cfg = getConfig();
  const before = cfg.pipeline.jobs;
  cfg.pipeline.jobs = {};
  try {
    const retry = jobSpec("tag-retry-failed");
    assert.ok(retry, "tag-retry-failed must resolve without a jobs block");
    assert.deepEqual(retry.command.slice(1), ["tag", "--retry-failed"]);
    assert.equal(retry.llm, true);
    const untagged = jobSpec("tag-untagged");
    assert.deepEqual(untagged.command.slice(1), ["tag", "--requeue-untagged"]);
    assert.equal(jobSpec("nope"), null);
  } finally {
    cfg.pipeline.jobs = before;
  }
});

test("one canonical pass fills three tables and marks only answered URLs", async () => {
  const { dir, path } = tmpDb();
  const restoreLogs = quiet();
  seedUrls(path, [
    { id: "u1", url: "https://a.com/1" },
    { id: "u2", url: "https://a.com/2" },
  ]);
  const restoreFetch = stubProvider([0]);
  try {
    await runOfflineTagWorker({
      dbPath: path, provider: provider(), model: "m", prompt: "Classify.",
      validTags: ["news"], batchSize: 2, max: 1,
    });
  } finally {
    restoreFetch();
    restoreLogs();
  }
  const db = new Database(path, { readonly: true });
  const tags = db.prepare("SELECT * FROM local_url_tags").all();
  const attrs = db.prepare("SELECT * FROM local_url_attributes").all();
  const quality = db.prepare("SELECT * FROM local_url_quality").all();
  const markers = db.prepare("SELECT * FROM local_url_tagged_by ORDER BY url_id").all();
  db.close();

  assert.equal(tags.length, 1, "only the answered URL carries tags");
  assert.equal(attrs.length, 1, "attributes are written in the same pass");
  assert.equal(quality.length, 1, "quality is written in the same pass");
  assert.deepEqual(markers.map((m) => m.url_id), ["u1"], "the unanswered URL stays unmarked");
  assert.deepEqual(JSON.parse(attrs[0].tone), ["serious"], "tone is stored as a JSON array (formal → serious)");

  rmSync(dir, { recursive: true, force: true });
});

test("a stale known-URLs index is surfaced as a failing check", async () => {
  const { utimesSync } = await import("node:fs");
  const { pipelineStatus } = await import("../src/interfaces/pipeline.js");
  const dir = mkdtempSync(join(tmpdir(), "skyhook-index-"));
  const idx = join(dir, "known-urls.db");
  const db = new Database(idx);
  db.exec("CREATE TABLE known_urls (url TEXT PRIMARY KEY)");
  db.close();
  // 30 days old: past the 7-day warning line.
  const old = new Date(Date.now() - 30 * 86400000);
  utimesSync(idx, old, old);

  const cfg = getConfig();
  const before = { knownUrlsDb: cfg.pipeline.knownUrlsDb, status: cfg.pipeline.status, stagedDir: cfg.stagedDir };
  cfg.pipeline.knownUrlsDb = idx;
  cfg.pipeline.status = null;
  cfg.stagedDir = dir;
  try {
    const status = pipelineStatus();
    const check = (status.checks || []).find((c) => /known-urls/i.test(c.label || ""));
    assert.ok(check, "a known-URLs check should be present");
    assert.equal(check.ok, false, "a 30-day-old index is stale");
  } finally {
    cfg.pipeline.knownUrlsDb = before.knownUrlsDb;
    cfg.pipeline.status = before.status;
    cfg.stagedDir = before.stagedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

