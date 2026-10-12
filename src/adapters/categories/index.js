/**
 * categories/index.js — editable category taxonomy.
 *
 * Loads a `categories.json` of stable string ids (+ labels + optional
 * `externalId`). Exposes `CATEGORY` / `SUBCATEGORY` / `SUBCATEGORY_BY_CATEGORY`
 * so seeders can reference them exactly as before:
 *
 *   category_id: CATEGORY.SCIENCE          // "SCIENCE", or the mapped UUID
 *   subcategory_id: SUBCATEGORY.SPACE_ASTRONOMY
 *
 * If a category has an `externalId` (e.g. a UUID or FK your DB expects), that
 * value is used instead of the string id — this is how an overlay maps the
 * same constants back onto its own DB ids without touching any seeder.
 */
import { readFileSync, existsSync } from "fs";

let _cat = null;

function humanize(name) {
  return String(name)
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function loadCategories(file) {
  if (!existsSync(file)) {
    throw new Error(`Categories file not found: ${file} (set categoriesFile in skyhook.config.json)`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));

  const CATEGORY = {};
  const SUBCATEGORY = {};
  const SUBCATEGORY_BY_CATEGORY = {};
  const categories = [];
  const subcategories = [];

  for (const c of raw.categories || []) {
    const id = String(c.id);
    const value = c.externalId ?? id;
    CATEGORY[id] = value;
    SUBCATEGORY_BY_CATEGORY[value] = [];
    categories.push({ id, label: c.label || humanize(id), externalId: c.externalId ?? null });
  }
  for (const s of raw.subcategories || []) {
    const id = String(s.id);
    const value = s.externalId ?? id;
    SUBCATEGORY[id] = value;
    const parentValue = CATEGORY[String(s.category)];
    if (SUBCATEGORY_BY_CATEGORY[parentValue]) SUBCATEGORY_BY_CATEGORY[parentValue].push(value);
    subcategories.push({ id, label: s.label || humanize(id), category: String(s.category), externalId: s.externalId ?? null });
  }

  _cat = { CATEGORY, SUBCATEGORY, SUBCATEGORY_BY_CATEGORY, categories, subcategories };
  return _cat;
}

export function getCategories() {
  return _cat;
}

/** Resolve a subcategory by id or label (no DB round-trip). */
export function findSubcategory(name) {
  if (!_cat) return null;
  const q = String(name ?? "").toLowerCase();
  return _cat.subcategories.find(
    (s) => s.id.toLowerCase() === q || (s.label || "").toLowerCase() === q,
  ) ?? null;
}

/** Backward-compatible helper (was a Supabase query in the original engine). */
export async function getSubcategoryId(name) {
  const s = findSubcategory(name);
  return s ? (s.externalId ?? s.id) : null;
}
