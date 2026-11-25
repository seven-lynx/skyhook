/**
 * enums.js — map a value the tagger emitted onto one the target schema accepts.
 *
 * One table drives everything: `tagging.enums` in `skyhook.config.json`
 * (`src/config.js` `DEFAULTS` carries the defaults). The mapper is a pure
 * function of `(column, value, table)` so it can be tested without a database,
 * and it never invents a value:
 *
 *   1. accepted list        -> the value, unchanged
 *   2. alias                -> the alias target, when that target is accepted
 *   3. fallback             -> the column's documented default
 *   4. no fallback          -> undefined, and the caller drops the column
 *
 * Arrays (a JSON-array string in SQLite, a real array in JSON) are the one
 * shape difference between the two writers: the canonical worker stores `tone`
 * as `["neutral"]`, task mode stores `neutral`. Both become an array here.
 */
import { getConfig } from "../../config.js";

const EMPTY = {
  values: {}, aliases: {}, fallbacks: {}, arrays: [], booleans: [],
};

/** The enum table in force, normalised so callers can index it blindly. */
export function enumTable(cfg = getConfig()) {
  const raw = cfg?.tagging?.enums;
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  return {
    values: raw.values && typeof raw.values === "object" ? raw.values : {},
    aliases: raw.aliases && typeof raw.aliases === "object" ? raw.aliases : {},
    fallbacks: raw.fallbacks && typeof raw.fallbacks === "object" ? raw.fallbacks : {},
    arrays: Array.isArray(raw.arrays) ? raw.arrays : [],
    booleans: Array.isArray(raw.booleans) ? raw.booleans : [],
  };
}

function slug(v) {
  return String(v ?? "").trim().toLowerCase();
}

/** Parse a value that may be an array, a JSON-array string, or a bare scalar. */
export function toArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(slug).filter(Boolean);
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(slug).filter(Boolean);
      } catch { /* fall through to the scalar path */ }
      return [];
    }
    return t ? [slug(t)] : [];
  }
  return [slug(value)].filter(Boolean);
}

/**
 * Map one value onto the accepted set for `column`.
 * @returns {{ value: any, reason: string|null }}
 */
export function mapColumnValue(column, value, table = enumTable()) {
  if (table.booleans.includes(column)) {
    return { value: value === true || value === 1 || value === "1" || value === "true", reason: null };
  }

  const accepted = table.values[column];
  if (!Array.isArray(accepted)) {
    // No declared vocabulary for this column: only normalise arrays.
    if (table.arrays.includes(column)) return { value: toArray(value), reason: null };
    return { value, reason: null };
  }

  const isArrayColumn = table.arrays.includes(column);
  const raw = isArrayColumn ? toArray(value) : [slug(value)].filter(Boolean);
  const aliases = table.aliases[column] || {};
  const out = [];
  const rejected = [];

  for (const item of raw) {
    if (accepted.includes(item)) { out.push(item); continue; }
    const alias = aliases[item];
    if (alias && accepted.includes(alias)) { out.push(alias); continue; }
    rejected.push(item);
  }

  if (isArrayColumn) {
    if (out.length) return { value: out, reason: rejected.length ? `dropped:${rejected.join(",")}` : null };
    const fb = table.fallbacks[column];
    const fallback = Array.isArray(fb) ? fb.filter((v) => accepted.includes(slug(v))) : [];
    return {
      value: fallback.length ? fallback : [],
      reason: rejected.length ? `fallback:${rejected.join(",")}` : null,
    };
  }

  if (out.length) return { value: out[0], reason: rejected.length ? `dropped:${rejected.join(",")}` : null };
  const fb = table.fallbacks[column];
  if (fb != null && (Array.isArray(fb) ? accepted.includes(slug(fb[0])) : accepted.includes(slug(fb)))) {
    return { value: Array.isArray(fb) ? slug(fb[0]) : slug(fb), reason: `fallback:${rejected.join(",")}` };
  }
  return { value: undefined, reason: `unmapped:${rejected.join(",")}` };
}

/**
 * Map a whole row. Returns the row to send plus a per-column reason for
 * anything that was dropped, so the caller can count it once per run.
 */
export function mapRow(row, table = enumTable()) {
  const out = {};
  const reasons = {};
  for (const [column, value] of Object.entries(row)) {
    const { value: mapped, reason } = mapColumnValue(column, value, table);
    if (reason) reasons[column] = reason;
    if (mapped !== undefined) out[column] = mapped;
  }
  return { row: out, reasons };
}

/** Merge per-run counters, so `upload` can log one line instead of one per batch. */
export function mergeStats(into, reasons) {
  for (const [column, reason] of Object.entries(reasons || {})) {
    into[column] = (into[column] || 0) + 1;
  }
  return into;
}
