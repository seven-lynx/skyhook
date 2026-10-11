/**
 * storage/index.js — StorageAdapter contract, registry, and schema mapping.
 *
 * A StorageAdapter is the single seam between Skyhook and a user's database.
 * The engine produces rows in *canonical* field names; each adapter maps those
 * canonical fields onto the user's actual table/columns via `schema.json`, then
 * writes them. Adapters self-register via `registerStorage`.
 */
import { readFileSync, existsSync } from "fs";

/** Canonical fields a seeder may produce on a row. */
export const CANONICAL_FIELDS = [
  "url", "original_url", "title", "description", "og_image_url",
  "category_id", "subcategory_id", "source", "language", "published_at",
  "seeder_score", "tags",
];

/** Load a schema.json mapping file, or return null when absent. */
export function loadSchema(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Map a canonical row onto the user's schema (columns + extra defaults). */
export function mapRow(row, schema) {
  if (!schema?.columns) return { ...row };
  const out = {};
  for (const [canonical, column] of Object.entries(schema.columns)) {
    if (row[canonical] !== undefined) out[column] = row[canonical];
  }
  if (schema.extra) Object.assign(out, schema.extra);
  return out;
}

const adapters = Object.create(null);

export function registerStorage(id, factory) {
  adapters[id] = factory;
}

export async function createStorage(config) {
  const provider = config?.storage?.provider || "stage";
  let factory = adapters[provider];
  if (!factory) {
    // Lazily import the provider module, which self-registers on load.
    try {
      await import(`./${provider}.js`);
      factory = adapters[provider];
    } catch {
      /* fall through to the error below */
    }
  }
  if (!factory) {
    throw new Error(
      `Unknown storage provider "${provider}". Available: ${Object.keys(adapters).join(", ") || "(none)"}`,
    );
  }
  return factory(config);
}
