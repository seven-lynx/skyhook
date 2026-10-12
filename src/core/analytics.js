/**
 * analytics.js — counts + percentages over collected URLs.
 *
 * `aggregateRows(rows)` is pure and works over any canonical row set; the
 * staged-backed `statsFromStaged()` reads the offline working set so it works
 * identically on the Pi (stage-only) and the PC.
 */
import { CATEGORY, SUBCATEGORY } from "./seed.js";
import { readStaged } from "./staged.js";

function reverse(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[v] = k;
  return out;
}

export function humanize(id) {
  if (!id) return "(none)";
  return String(id)
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function aggregateRows(rows) {
  const total = rows.length;
  const bySource = new Map();
  const byCategory = new Map();
  const bySubcategory = new Map();
  const byLanguage = new Map();
  const catValToId = reverse(CATEGORY);
  const subValToId = reverse(SUBCATEGORY);
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const r of rows) {
    bump(bySource, r.source || "(none)");
    bump(byCategory, catValToId[r.category_id] ?? r.category_id ?? "(none)");
    bump(bySubcategory, subValToId[r.subcategory_id] ?? r.subcategory_id ?? "(none)");
    bump(byLanguage, r.language || "(none)");
  }

  const toSorted = (m) =>
    [...m.entries()]
      .map(([key, count]) => ({
        key,
        label: humanize(key),
        count,
        pct: total ? +((count / total) * 100).toFixed(2) : 0,
      }))
      .sort((a, b) => b.count - a.count);

  return {
    total,
    seeders: bySource.size,
    bySource: toSorted(bySource),
    byCategory: toSorted(byCategory),
    bySubcategory: toSorted(bySubcategory),
    byLanguage: toSorted(byLanguage),
  };
}

export function statsFromStaged({ source = null } = {}) {
  return aggregateRows(readStaged({ source }));
}
