/**
 * storage/postgres.js — PostgreSQL adapter (node-postgres).
 *
 * Works against any Postgres database. Table + column names come from the
 * user's `schema.json`; the connection comes from `storage.connectionString`
 * (or POSTGRES_URL / DATABASE_URL) — otherwise node-postgres reads the standard
 * PG* environment variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 */
import { registerStorage, loadSchema, mapRow, CANONICAL_FIELDS } from "./index.js";

registerStorage("postgres", async (config) => {
  let Pool;
  try {
    const mod = await import("pg");
    Pool = mod.Pool ?? mod.default?.Pool;
  } catch {
    throw new Error("Postgres storage requires 'pg'. Install it: npm i pg");
  }
  if (!Pool) throw new Error("Could not load 'pg' Pool.");

  const connectionString =
    config.storage?.connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || null;

  const schema = loadSchema(config.storage?.schemaFile) || {};
  const table = schema.table || "links";
  const urlCol = schema.columns?.url || "url";
  const columns = schema.columns
    ? Object.values(schema.columns)
    : CANONICAL_FIELDS.filter((f) => f !== "tags" && f !== "original_url");

  const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
  const colList = columns.map(q).join(", ");
  const urlQ = q(urlCol);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

  const pool = connectionString ? new Pool({ connectionString }) : new Pool();

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${q(table)} (${columns.map((c) => `${q(c)} TEXT`).join(", ")}, UNIQUE(${urlQ}))`,
  );

  return {
    provider: "postgres",
    async findExisting(urls) {
      const existing = new Set();
      for (let i = 0; i < urls.length; i += 500) {
        const chunk = urls.slice(i, i + 500);
        const res = await pool.query(`SELECT ${urlQ} FROM ${q(table)} WHERE ${urlQ} = ANY($1::text[])`, [chunk]);
        for (const r of res.rows) existing.add(r[urlCol]);
      }
      return existing;
    },
    async upsert(rows) {
      let inserted = 0;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const r of rows) {
          const mapped = mapRow(r, schema);
          const values = columns.map((c) => mapped[c] ?? null);
          const res = await client.query(
            `INSERT INTO ${q(table)} (${colList}) VALUES (${placeholders}) ON CONFLICT (${urlQ}) DO NOTHING`,
            values,
          );
          inserted += res.rowCount ?? 0;
        }
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        client.release();
      }
      return { inserted, skipped: rows.length - inserted };
    },
    async close() {
      await pool.end();
    },
  };
});
