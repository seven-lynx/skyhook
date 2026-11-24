/**
 * offline-pipeline.js — pull untagged/all URLs from storage into the offline DB
 * and upload local tags/URLs back. (Migrated from Roam's export-db / export-untagged /
 * sync-existing / import-staged / upload-tagged / upload-tags scripts.)
 *
 * The offline DB (pipeline.offlineDb) is a local SQLite copy of the production
 * `urls` table plus the local tagging tables written by the offline tag worker.
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { enumTable, mapRow, mergeStats } from "../adapters/tagging/enums.js";

async function sbClient(config) {
  const { createClient } = await import("@supabase/supabase-js");
  if (!config.storage?.url || !config.storage?.serviceRoleKey) {
    throw new Error("storage.url and storage.serviceRoleKey are required (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env).");
  }
  return createClient(config.storage.url, config.storage.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function openOffline(config) {
  const p = config.pipeline?.offlineDb;
  if (!p) throw new Error("pipeline.offlineDb is not configured");
  if (!existsSync(p)) throw new Error(`Offline DB not found: ${p}. Run a full export first.`);
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  return db;
}

function knownDbPath(config) {
  return config.pipeline?.knownUrlsDb || join(config.dataDir || ".skyhook", "known-urls.db");
}

function stagedDir(config) {
  return config.stagedDir || join(config.dataDir || ".skyhook", "staged");
}

// ── 1. Sync the "known URLs" dedup index ────────────────────────────────────
async function syncKnownUrls(sb, config) {
  const path = knownDbPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS known_urls (url TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  const insertStmt = db.prepare("INSERT OR IGNORE INTO known_urls (url) VALUES (?)");

  // Full re-scan by primary key (id), idempotent via INSERT OR IGNORE. We re-scan
  // the whole table every time because urls.id is a random UUID (not time-ordered),
  // so a cursor resume would silently miss newly-inserted rows. This keeps the
  // index a complete superset so staged seeder URLs can be dedup'd before tagging.
  const PAGE = 2000;
  let lastId = null, scanned = 0, inserted = 0;
  const t0 = Date.now();
  while (true) {
    let q = sb.from("urls").select("url, id").order("id", { ascending: true }).limit(PAGE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    db.transaction((rows) => { for (const r of rows) inserted += insertStmt.run(r.url).changes; })(data);
    scanned += data.length;
    lastId = data[data.length - 1].id;
    process.stdout.write(`\r  indexed ${scanned.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log("");
  setMeta("last_sync_at", new Date().toISOString());
  db.close();
  return { scanned, inserted };
}

// ── 2. Pull URLs from storage → offline DB ──────────────────────────────────
const PULL_COLS = [
  "id", "url", "title", "description", "og_image_url", "category_id", "subcategory_id",
  "source", "language", "published_at", "seeder_score", "approved", "inactive",
  "wilson_score", "created_at", "domain",
];

async function pullUrls(sb, db, { force = false, max = null }) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='urls'").get()) {
    throw new Error("'urls' table not found in offline DB — run a full export first.");
  }
  const cols = db.prepare("PRAGMA table_info(urls)").all().map((c) => c.name);
  const insertCols = PULL_COLS.filter((c) => cols.includes(c));
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO urls (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertStmt.run(...insertCols.map((col) => {
        const v = row[col];
        if (v == null) return null;
        if (typeof v === "boolean") return v ? 1 : 0;
        if (typeof v === "object") return JSON.stringify(v);
        return v;
      }));
    }
  });

  const taggedIds = new Set(db.prepare("SELECT url_id FROM local_url_tags").all().map((r) => r.url_id));
  const existingIds = new Set(db.prepare("SELECT id FROM urls").all().map((r) => r.id));

  const PAGE = 2000;
  let lastId = null, fetched = 0, inserted = 0;
  const t0 = Date.now();
  while (true) {
    let q = sb.from("urls").select(PULL_COLS.join(",")).eq("approved", true).eq("inactive", false).order("id", { ascending: true }).limit(PAGE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    const fresh = force
      ? data.filter((u) => !existingIds.has(u.id))
      : data.filter((u) => !taggedIds.has(u.id) && !existingIds.has(u.id));

    if (fresh.length) { insertMany(fresh); inserted += fresh.length; }
    fetched += data.length;
    lastId = data[data.length - 1].id;
    if (max && inserted >= max) break;
    process.stdout.write(`\r  fetched ${fetched.toLocaleString()} | new ${inserted.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log("");
  return { fetched, inserted };
}

// ── 3. Import staged seeder JSONL → offline DB ──────────────────────────────
function importStaged(db, config, knownDb) {
  const dir = stagedDir(config);
  if (!existsSync(dir)) return { files: 0, imported: 0, skipped: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (!files.length) return { files: 0, imported: 0, skipped: 0 };

  let cols = db.prepare("PRAGMA table_info(urls)").all().map((c) => c.name);
  if (!cols.includes("is_staged")) { db.exec("ALTER TABLE urls ADD COLUMN is_staged INTEGER DEFAULT 0"); cols.push("is_staged"); }
  db.exec("CREATE INDEX IF NOT EXISTS idx_urls_url ON urls(url)");
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_url_uniq ON urls(url)"); } catch { /* legacy duplicate rows - in-memory + known/roam checks still guard */ }

  const knownHas = knownDb.prepare("SELECT 1 FROM known_urls WHERE url = ?");
  const knownAdd = knownDb.prepare("INSERT OR IGNORE INTO known_urls (url) VALUES (?)");
  const roamHas = db.prepare("SELECT 1 FROM urls WHERE url = ?");

  const FIELD_TO_COL = {
    id: "id", url: "url", title: "title", description: "description",
    og_image_url: "og_image_url", category_id: "category_id", subcategory_id: "subcategory_id",
    source: "source", language: "language", published_at: "published_at",
    seeder_score: "seeder_score", approved: "approved", inactive: "inactive", is_staged: "is_staged",
  };
  const insertCols = Object.values(FIELD_TO_COL).filter((c) => cols.includes(c));
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO urls (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`);

  const consumedDir = join(dir, "consumed");
  let imported = 0, skipped = 0, total = 0;
  const seen = new Set(); // URLs inserted this run (in-memory dedup within the import)

  for (const file of files) {
    const path = join(dir, file);
    let lines;
    try { lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean); } catch { continue; }
    const rows = [];
    for (const line of lines) { try { rows.push(JSON.parse(line)); } catch {} }

    db.transaction(() => {
      for (const r of rows) {
        if (!r.url) continue;
        total++;
        if (seen.has(r.url)) { skipped++; continue; }
        if (knownHas.get(r.url)) { skipped++; continue; }
        if (roamHas.get(r.url)) { skipped++; knownAdd.run(r.url); continue; }
        const vals = insertCols.map((col) => {
          switch (col) {
            case "id": return randomUUID();
            case "url": return r.url;
            case "title": return r.title ?? null;
            case "description": return r.description ?? null;
            case "og_image_url": return r.og_image_url ?? null;
            case "category_id": return r.category_id ?? null;
            case "subcategory_id": return r.subcategory_id ?? null;
            case "source": return r.source ?? "manual";
            case "language": return r.language ?? "en";
            case "published_at": return r.published_at ?? null;
            case "seeder_score": return typeof r.seeder_score === "number" ? r.seeder_score : 0;
            case "approved": return 1;
            case "inactive": return 0;
            case "is_staged": return 1;
            default: return null;
          }
        });
        insertStmt.run(...vals);
        seen.add(r.url);
        knownAdd.run(r.url);
        imported++;
      }
    })();

    mkdirSync(consumedDir, { recursive: true });
    renameSync(path, join(consumedDir, file));
  }
  return { files: files.length, imported, skipped };
}

/** Import staged seeder JSONL into the offline DB without a Supabase round-trip. */
export function importStagedToOffline({ config }) {
  const db = openOffline(config);
  try {
    const kPath = knownDbPath(config);
    mkdirSync(dirname(kPath), { recursive: true });
    const kdb = new Database(kPath);
    try {
      kdb.exec("CREATE TABLE IF NOT EXISTS known_urls (url TEXT PRIMARY KEY)");
      kdb.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      return importStaged(db, config, kdb);
    } finally {
      kdb.close();
    }
  } finally {
    db.close();
  }
}

/** Pull: sync known-URLs index, pull untagged/all URLs, import staged seeders. */
export async function pullOffline({ config, force = false, max = null, indexOnly = false }) {
  const sb = await sbClient(config);

  console.log("Syncing known-URLs index…");
  const known = await syncKnownUrls(sb, config);
  console.log(`  ${known.scanned.toLocaleString()} scanned, ${known.inserted.toLocaleString()} new`);

  if (indexOnly) return { known };

  const db = openOffline(config);
  try {
    console.log(`${force ? "Full" : "Untagged"} pull from storage…`);
    const pulled = await pullUrls(sb, db, { force, max });
    console.log(`  fetched ${pulled.fetched.toLocaleString()}, inserted ${pulled.inserted.toLocaleString()}`);

    console.log("Importing staged seeder URLs…");
    const kdb = new Database(knownDbPath(config));
    try { const imp = importStaged(db, config, kdb); console.log(`  ${imp.imported.toLocaleString()} imported, ${imp.skipped.toLocaleString()} skipped`); }
    finally { kdb.close(); }

    return { pulled, known };
  } finally {
    db.close();
  }
}

// ── 4. Upload staged URLs → storage (remap local UUID → production id) ─────
async function uploadStagedUrls(sb, db, { dryRun = false }) {
  const staged = db.prepare("SELECT * FROM urls WHERE is_staged = 1").all();
  if (!staged.length) return { staged: 0, inserted: 0, remapped: 0, existing: 0 };

  const TAG_TABLES = ["local_url_tags", "local_url_attributes", "local_url_quality"];
  const remap = db.transaction((fromId, toId) => {
    for (const t of TAG_TABLES) {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`).get()) {
        db.prepare(`UPDATE ${t} SET url_id = ? WHERE url_id = ?`).run(toId, fromId);
      }
    }
  });

  const toInsert = [];
  let existing = 0, remapped = 0;
  // One round trip per CHUNK, not per row: a 180k-row import otherwise spends
  // 180k queries before it inserts anything.
  const CHUNK = 100;
  const idByUrl = new Map();
  for (let i = 0; i < staged.length; i += CHUNK) {
    const chunk = staged.slice(i, i + CHUNK).map((r) => r.url);
    const { data, error } = await sb.from("urls").select("id, url").in("url", chunk);
    if (error) throw new Error(`Existence check failed: ${error.message}`);
    for (const r of data || []) idByUrl.set(r.url, r.id);
  }
  for (const r of staged) {
    const realId = idByUrl.get(r.url);
    if (realId) {
      if (realId !== r.id) { if (!dryRun) remap(r.id, realId); remapped++; }
      existing++;
    } else {
      toInsert.push(r);
    }
  }

  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map((r) => ({
      id: r.id, url: r.url, title: r.title ?? null, description: r.description ?? null,
      og_image_url: r.og_image_url ?? null, category_id: r.category_id ?? null,
      subcategory_id: r.subcategory_id ?? null, source: r.source ?? "manual",
      language: r.language ?? "en", published_at: r.published_at ?? null,
      seeder_score: typeof r.seeder_score === "number" ? r.seeder_score : 0,
      approved: true,
    }));
    if (!dryRun) {
      const { error } = await sb.from("urls").upsert(batch, { onConflict: "url", ignoreDuplicates: true });
      if (error) console.error(`  ❌ Insert error: ${error.message}`);
    }
    inserted += batch.length;
  }

  if (!dryRun) db.prepare("UPDATE urls SET is_staged = 0 WHERE is_staged = 1").run();
  return { staged: staged.length, inserted, remapped, existing };
}

// ── 5. Upload local tags/attributes/quality → storage ───────────────────────
//
// Every loop pages by a `rowid` keyset, not by `limit`/`offset`. The loop marks
// the rows it just sent, so those rows leave the `synced = 0` predicate; an
// OFFSET cursor then steps over an equal number of still-unsynced rows, and one
// pass uploads about half its backlog.
function unsyncedPager(db, table, columns, batchSize) {
  const sql = `SELECT rowid AS _rowid, ${columns} FROM ${table}
               WHERE (synced = 0 OR synced IS NULL) AND rowid > ?
               ORDER BY rowid LIMIT ?`;
  const stmt = db.prepare(sql);
  return (last) => stmt.all(last, batchSize);
}

export async function uploadTagRows(sb, db, { batchSize = 500, uploadSource = "llm" }) {
  const { data: tagRows, error: lookupErr } = await sb.from("tags").select("id, slug");
  if (lookupErr) throw new Error(`Failed to load tags: ${lookupErr.message}`);
  const idBySlug = new Map((tagRows || []).map((t) => [t.slug, t.id]));

  const page = unsyncedPager(db, "local_url_tags",
    "url_id, tag_slug, confidence, source, created_at", batchSize);
  const mark = db.prepare("UPDATE local_url_tags SET synced = 1 WHERE url_id = ? AND tag_slug = ?");

  let lastRowid = 0, uploaded = 0, skipped = 0;
  while (true) {
    const rows = page(lastRowid);
    if (rows.length === 0) break;
    const resolved = [], markSynced = [];
    for (const r of rows) {
      const tagId = idBySlug.get(r.tag_slug);
      if (!tagId) { skipped++; continue; }
      resolved.push({
        url_id: r.url_id, tag_id: tagId, confidence: r.confidence,
        source: uploadSource, created_at: r.created_at,
      });
      markSynced.push([r.url_id, r.tag_slug]);
    }
    if (resolved.length) {
      const { error } = await sb.from("url_tags").upsert(resolved, { onConflict: "url_id, tag_id" });
      if (error) throw error;
      for (const [urlId, tagSlug] of markSynced) mark.run(urlId, tagSlug);
      uploaded += resolved.length;
    }
    lastRowid = rows[rows.length - 1]._rowid;
  }
  return { uploaded, skipped };
}

export async function uploadAttrRows(sb, db, { batchSize = 500, enums, dropped = {} }) {
  const page = unsyncedPager(db, "local_url_attributes",
    "url_id, audience_level, content_type, depth, tone, is_news, confidence, created_at", batchSize);
  const mark = db.prepare("UPDATE local_url_attributes SET synced = 1 WHERE url_id = ?");

  let lastRowid = 0, uploaded = 0;
  while (true) {
    const rows = page(lastRowid);
    if (rows.length === 0) break;
    const payload = rows.map((r) => {
      const { row, reasons } = mapRow({
        url_id: r.url_id, audience_level: r.audience_level, content_type: r.content_type,
        depth: r.depth, tone: r.tone, is_news: r.is_news, confidence: r.confidence,
        created_at: r.created_at,
      }, enums);
      mergeStats(dropped, reasons);
      return row;
    });
    const { error } = await sb.from("url_attributes").upsert(payload, { onConflict: "url_id" });
    if (error) throw error;
    for (const r of rows) mark.run(r.url_id);
    uploaded += rows.length;
    lastRowid = rows[rows.length - 1]._rowid;
  }
  return { uploaded };
}

export async function uploadQualityRows(sb, db, { batchSize = 500, enums, dropped = {} }) {
  const page = unsyncedPager(db, "local_url_quality",
    "url_id, url_type, quality_score, is_parked, is_product, is_spam, is_paywalled, is_login_required, is_broken, is_thin, is_clickbait, is_english, confidence, created_at", batchSize);
  const mark = db.prepare("UPDATE local_url_quality SET synced = 1 WHERE url_id = ?");

  let lastRowid = 0, uploaded = 0;
  while (true) {
    const rows = page(lastRowid);
    if (rows.length === 0) break;
    const payload = rows.map((r) => {
      const { row, reasons } = mapRow({
        url_id: r.url_id, url_type: r.url_type, quality_score: r.quality_score,
        is_parked: r.is_parked, is_product: r.is_product, is_spam: r.is_spam,
        is_paywalled: r.is_paywalled, is_login_required: r.is_login_required,
        is_broken: r.is_broken, is_thin: r.is_thin, is_clickbait: r.is_clickbait,
        is_english: r.is_english, confidence: r.confidence, created_at: r.created_at,
      }, enums);
      mergeStats(dropped, reasons);
      return row;
    });
    const { error } = await sb.from("url_quality").upsert(payload, { onConflict: "url_id" });
    if (error) throw error;
    for (const r of rows) mark.run(r.url_id);
    uploaded += rows.length;
    lastRowid = rows[rows.length - 1]._rowid;
  }
  return { uploaded };
}

/** Upload: push staged URLs + local tags/attributes/quality → storage. */
export async function uploadOffline({ config, dryRun = false, batchSize = 500 }) {
  const sb = await sbClient(config);
  const db = openOffline(config);
  try {
    // Ensure synced columns exist on the local tag tables.
    for (const table of ["local_url_tags", "local_url_attributes", "local_url_quality"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("synced")) db.exec(`ALTER TABLE ${table} ADD COLUMN synced INTEGER DEFAULT 0`);
    }

    const enums = enumTable(config);
    const uploadSource = config.tagging?.uploadSource || "llm";
    const dropped = {};

    console.log("Uploading staged URLs…");
    const urls = await uploadStagedUrls(sb, db, { dryRun });
    console.log(`  ${urls.staged.toLocaleString()} staged, ${urls.inserted.toLocaleString()} new, ${urls.existing.toLocaleString()} existing (${urls.remapped} remapped)`);

    console.log("Uploading tags…");
    const tags = await uploadTagRows(sb, db, { batchSize, uploadSource });
    console.log(`  ${tags.uploaded.toLocaleString()} tags uploaded${tags.skipped ? ` (${tags.skipped} skipped: slug not in the target vocabulary)` : ""}`);

    console.log("Uploading attributes…");
    const attrs = await uploadAttrRows(sb, db, { batchSize, enums, dropped });
    console.log(`  ${attrs.uploaded.toLocaleString()} attributes uploaded`);

    console.log("Uploading quality…");
    const quality = await uploadQualityRows(sb, db, { batchSize, enums, dropped });
    console.log(`  ${quality.uploaded.toLocaleString()} quality assessments uploaded`);

    if (Object.keys(dropped).length) {
      const summary = Object.entries(dropped).map(([c, n]) => `${c} ${n}`).join(", ");
      console.log(`  mapped or dropped values: ${summary}`);
    }

    return { urls, tags, attrs, quality, mapped: dropped };
  } finally {
    db.close();
  }
}