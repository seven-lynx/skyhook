/**
 * offline-worker.test.mjs — what a requeue costs and when it stops.
 *
 * The one behaviour worth a test is the queue's post-condition: `tag` marks
 * what the model answered, and a URL the model answered with no surviving tag
 * is *recorded as such*. Without that record a requeue re-selects it every
 * pass, so the tail never reaches zero (#19) — the failure this file exists to
 * keep out. The model is a stubbed `fetch`; the DB is a temp directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { runOfflineTagWorker } from "../src/adapters/tagging/offline-worker.js";

const root = process.cwd();
const SOURCE = "llm";

function fixture(name) {
  const dir = join(root, `.tmp-worker-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "offline.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE urls (
    id TEXT PRIMARY KEY, title TEXT, description TEXT, url TEXT,
    approved INTEGER, inactive INTEGER, category_id TEXT, subcategory_id TEXT)`);
  const insert = db.prepare(
    "INSERT INTO urls (id, title, description, url, approved, inactive) VALUES (?, ?, ?, ?, 1, 0)",
  );
  insert.run("u1", "A page the model can tag", null, "https://a.example/x");
  insert.run("u2", "A page it answers with nothing", null, "https://b.example/y");
  db.close();
  return { dir, dbPath };
}

/** Answers the first batch by index, and every later one with no tags. */
function stubModel() {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages.map((m) => m.content).join("\n");
    calls.push(user);
    const count = [...user.matchAll(/\[URL \d+\]/g)].length;
    const first = calls.length === 1;
    const results = Array.from({ length: count }, (_, i) => ({
      url_index: i,
      tags: first && i === 0 ? [{ slug: "technology", confidence: 0.9 }] : [],
      attributes: { audience_level: "general", content_type: "other", depth: "medium", tone: "neutral", is_news: false },
      quality: { url_type: "other", quality_score: 5, flags: {} },
    }));
    const content = JSON.stringify({ results });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

const opts = (dbPath) => ({
  dbPath,
  provider: { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
  model: "test-model",
  prompt: "Tag the URLs.",
  validTags: ["technology"],
  modelSource: SOURCE,
  batchSize: 25,
});

function markers(dbPath) {
  const db = new Database(dbPath);
  try {
    return Object.fromEntries(["u1", "u2"].map((id) => [
      id,
      db.prepare("SELECT model_source FROM local_url_tagged_by WHERE url_id = ? ORDER BY model_source")
        .all(id).map((r) => r.model_source),
    ]));
  } finally { db.close(); }
}

function tagCount(dbPath, id) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) AS c FROM local_url_tags WHERE url_id = ?").get(id).c;
  } finally { db.close(); }
}

const original = globalThis.fetch;

test("an answered URL with no tag is recorded, not left for the next pass", async () => {
  const { dir, dbPath } = fixture("notags");
  const calls = stubModel();
  try {
    const result = await runOfflineTagWorker(opts(dbPath));
    assert.equal(result.processed, 2, "both URLs were answered");
    assert.equal(calls.length, 1);
    assert.deepEqual(markers(dbPath), {
      u1: [SOURCE],
      u2: [SOURCE, `${SOURCE}:no-tags`],
    });
    assert.equal(tagCount(dbPath, "u1"), 1, "the tagged URL keeps its tag");
    assert.equal(tagCount(dbPath, "u2"), 0, "no tag was invented for it");

    // A requeue now finds nothing to ask: the tail converged, which is the
    // whole point of the marker.
    const requeue = await runOfflineTagWorker({ ...opts(dbPath), requeueUntagged: true });
    assert.equal(calls.length, 1, "the requeue spent no model call");
    assert.equal(requeue.processed, 2, "and processed nothing new");

    // The way back is explicit, and it selects exactly the given-up rows.
    await runOfflineTagWorker({ ...opts(dbPath), reaskNoTags: true });
    assert.equal(calls.length, 2);
    assert.match(calls[1], /b\.example\/y/);
    assert.doesNotMatch(calls[1], /a\.example\/x/, "a tagged URL is not re-asked");
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

// #50: `--max` is a run budget. It was compared against `totalProcessed`, which is seeded from the
// persisted checkpoint, so on a DB that had been tagged before, `--max 1` exited immediately and
// `--max N` processed `N - checkpoint` URLs — the only way to run a bounded probe was to read
// `total_processed` out of `skyhook status` and ask for `checkpoint + n`.
test("--max bounds this run, not the lifetime checkpoint", async () => {
  const { dir, dbPath } = fixture("max");
  const calls = stubModel();
  try {
    const seeded = new Database(dbPath);
    seeded.prepare("INSERT INTO urls (id, title, description, url, approved, inactive) VALUES (?, ?, ?, ?, 1, 0)")
      .run("u3", "A third page", null, "https://c.example/z");
    seeded.close();

    // One full pass creates and fills the checkpoint table.
    const first = await runOfflineTagWorker(opts(dbPath));
    assert.equal(first.processed, 3, "the whole fixture was tagged");

    // ...then give the DB the history the issue measured, and queue one more URL.
    const history = new Database(dbPath);
    history.prepare("UPDATE local_tagging_progress SET total_processed = 1000 WHERE id = 1").run();
    history.prepare("INSERT INTO urls (id, title, description, url, approved, inactive) VALUES (?, ?, ?, ?, 1, 0)")
      .run("u4", "A bounded probe", null, "https://d.example/w");
    history.close();

    const before = calls.length;
    const bounded = await runOfflineTagWorker({ ...opts(dbPath), max: 1 });

    assert.equal(bounded.processedThisRun, 1, "--max counts this run, not the lifetime total");
    assert.equal(bounded.processed, 1001, "the checkpoint still advances by what the run did");
    assert.equal(calls.length, before + 1, "exactly one model call");
    assert.match(calls[calls.length - 1], /d\.example\/w/, "the run took the queued URL, not the checkpoint");
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

