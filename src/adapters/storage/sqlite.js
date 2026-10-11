/**
 * storage/sqlite.js — local SQLite adapter (no external service required).
 *
 * Proves Skyhook is fully self-contained: point it at a local .db file and the
 * engine writes there with zero external dependencies. The table is created
 * from `schema.json` columns (all TEXT; the conflict key column is UNIQUE).
 */
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { registerStorage, loadSchema, mapRow, CANONICAL_FIELDS } from "./index.js";

registerStorage("sqlite", async (config) => {
  const { default: Database } = await import("better-sqlite3");
  const dbFile = config.storage?.dbFile || join(config.dataDir, "skyhook.db");
  mkdirSync(dirname(dbFile), { recursive: true });

  const db = new Database(dbFile);
  const schema = loadSchema(config.storage?.schemaFile) || {};
  const table = schema.table || "links";
  const conflictKey = schema.conflictKey || "url";

  const columns = schema.columns
    ? Object.values(schema.columns)
    : CANONICAL_FIELDS.filter((f) => f !== "tags" && f !== "original_url");

  const defs = columns.map((c) => `"${c}" TEXT`).join(", ");
  const uniqueCol = schema.columns?.url || "url";
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${defs}, UNIQUE("${uniqueCol}"))`);

  const insertSql =
    `INSERT OR IGNORE INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")})`;

  return {
    provider: "sqlite",
    async findExisting(urls) {
      const existing = new Set();
      const urlCol = schema.columns?.url || "url";
      const stmt = db.prepare(`SELECT "${urlCol}" FROM "${table}" WHERE "${urlCol}" = ?`);
      for (const u of urls) {
        if (stmt.get(u)) existing.add(u);
      }
      return existing;
    },
    async upsert(rows) {
      const stmt = db.prepare(insertSql);
      let inserted = 0;
      const tx = db.transaction((batch) => {
        for (const r of batch) {
          const mapped = mapRow(r, schema);
          const values = columns.map((c) => mapped[c] ?? null);
          inserted += stmt.run(...values).changes;
        }
      });
      for (let i = 0; i < rows.length; i += 500) tx(rows.slice(i, i + 500));
      return { inserted, skipped: rows.length - inserted };
    },
  };
});
