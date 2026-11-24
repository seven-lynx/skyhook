import { test } from "node:test";
import assert from "node:assert/strict";
import { enumTable, mapColumnValue, mapRow, mergeStats, toArray } from "../src/adapters/tagging/enums.js";

const table = enumTable({ tagging: { enums: {
  values: {
    audience_level: ["beginner", "intermediate", "advanced", "expert", "general"],
    content_type: ["article", "tutorial", "other"],
    depth: ["quick-read", "medium", "deep-dive"],
    tone: ["academic", "technical", "accessible", "neutral", "journalistic"],
    url_type: ["article", "other"],
  },
  aliases: {
    audience_level: { advanced: "expert" },
    content_type: { howto: "tutorial" },
    tone: { formal: "academic", humorous: "neutral" },
  },
  fallbacks: {
    audience_level: "general", content_type: "other", depth: "medium",
    tone: ["neutral"], url_type: "other",
  },
  arrays: ["tone"],
  booleans: ["is_news", "is_parked"],
} } });

test("an accepted value is passed through unchanged", () => {
  assert.equal(mapColumnValue("audience_level", "beginner", table).value, "beginner");
  assert.equal(mapColumnValue("depth", "quick-read", table).reason, null);
});

test("an alias applies only when the raw value is not accepted", () => {
  // `advanced` is accepted here, so the alias to `expert` must not fire.
  assert.equal(mapColumnValue("audience_level", "advanced", table).value, "advanced");
  // A narrower table does not accept it, so the alias does.
  const narrow = { ...table, values: { ...table.values, audience_level: ["beginner", "expert", "general"] } };
  assert.equal(mapColumnValue("audience_level", "advanced", narrow).value, "expert");
});

test("an unmapped value falls back to the column default", () => {
  const r = mapColumnValue("content_type", "podcast", table);
  assert.equal(r.value, "other");
  assert.match(r.reason, /fallback:podcast/);
});

test("a column with no fallback is dropped rather than guessed", () => {
  const noFallback = { ...table, fallbacks: {} };
  const r = mapColumnValue("content_type", "podcast", noFallback);
  assert.equal(r.value, undefined);
  assert.match(r.reason, /unmapped/);
});

test("tone is always an array, from a JSON string, a bare string, or an array", () => {
  assert.deepEqual(mapColumnValue("tone", '["accessible"]', table).value, ["accessible"]);
  assert.deepEqual(mapColumnValue("tone", "accessible", table).value, ["accessible"]);
  assert.deepEqual(mapColumnValue("tone", ["technical", "academic"], table).value, ["technical", "academic"]);
});

test("an empty or fully unknown tone array becomes the fallback", () => {
  assert.deepEqual(mapColumnValue("tone", "[]", table).value, ["neutral"]);
  assert.deepEqual(mapColumnValue("tone", '["bogus"]', table).value, ["neutral"]);
});

test("unknown array elements are dropped, known ones survive", () => {
  const r = mapColumnValue("tone", '["accessible","bogus"]', table);
  assert.deepEqual(r.value, ["accessible"]);
  assert.match(r.reason, /dropped:bogus/);
});

test("booleans are coerced from the local 0/1 integers", () => {
  assert.equal(mapColumnValue("is_news", 1, table).value, true);
  assert.equal(mapColumnValue("is_news", 0, table).value, false);
  assert.equal(mapColumnValue("is_parked", "true", table).value, true);
});

test("mapRow keeps untouched columns and reports the mapped ones", () => {
  const { row, reasons } = mapRow({
    url_id: "u1", audience_level: "advanced", content_type: "podcast",
    depth: "medium", tone: '["formal","bogus"]', is_news: 0, confidence: 1,
  }, table);
  assert.equal(row.url_id, "u1");
  assert.equal(row.audience_level, "advanced");
  assert.equal(row.content_type, "other");
  assert.deepEqual(row.tone, ["academic"]);
  assert.equal(row.is_news, false);
  assert.equal(row.confidence, 1);
  assert.ok(reasons.content_type);
  assert.match(reasons.tone, /dropped:bogus/);
});

test("an alias that succeeds is not reported as a problem", () => {
  const { row, reasons } = mapRow({ tone: '["formal"]' }, table);
  assert.deepEqual(row.tone, ["academic"]);
  assert.equal(reasons.tone, undefined);
});

test("mergeStats accumulates per column", () => {
  const acc = {};
  mergeStats(acc, { tone: "fallback" });
  mergeStats(acc, { tone: "fallback", depth: "dropped" });
  assert.deepEqual(acc, { tone: 2, depth: 1 });
});

test("toArray tolerates null, bare strings and malformed JSON", () => {
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(" Neutral "), ["neutral"]);
  assert.deepEqual(toArray("[not json"), []);
});
