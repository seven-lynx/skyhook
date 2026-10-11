/**
 * storage/supabase.js — generic Supabase adapter.
 *
 * Works against any Supabase project. Table + column names come from the
 * user's `schema.json`; credentials come from config (or SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY in .env). Uses the service-role key (bypasses RLS).
 */
import { registerStorage, loadSchema, mapRow } from "./index.js";

async function loadClient() {
  try {
    return (await import("@supabase/supabase-js")).createClient;
  } catch {
    throw new Error(
      "Supabase storage requires '@supabase/supabase-js'. Install it: npm i @supabase/supabase-js",
    );
  }
}

registerStorage("supabase", async (config) => {
  const { url, serviceRoleKey } = config.storage || {};
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase storage needs storage.url and storage.serviceRoleKey (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env).");
  }
  const createClient = await loadClient();
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const schema = loadSchema(config.storage?.schemaFile) || {};
  const table = schema.table || "links";
  const urlCol = schema.columns?.url || "url";
  const conflictKey = schema.conflictKey || "url";

  return {
    provider: "supabase",
    async findExisting(urls) {
      const existing = new Set();
      for (let i = 0; i < urls.length; i += 500) {
        const chunk = urls.slice(i, i + 500);
        const { data } = await client.from(table).select(urlCol).in(urlCol, chunk);
        if (data) for (const r of data) existing.add(r[urlCol]);
      }
      return existing;
    },
    async upsert(rows) {
      let inserted = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500).map((r) => mapRow(r, schema));
        const { error, count } = await client
          .from(table)
          .upsert(batch, { onConflict: conflictKey, ignoreDuplicates: true })
          .select("id", { count: "exact", head: true });
        if (error) throw error;
        inserted += count ?? batch.length;
        skipped += Math.max(0, batch.length - (count ?? batch.length));
      }
      return { inserted, skipped };
    },
  };
});
