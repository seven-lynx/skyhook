import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { loadCategories } from "../src/adapters/categories/index.js";
import { createStorage } from "../src/adapters/storage/index.js";
import { buildPrompt } from "../src/adapters/tagging/index.js";
import { getConfig } from "../src/config.js";
import { aggregateRows } from "../src/core/analytics.js";
import { mergeRows, filterRows, readStaged, writeStagedSource } from "../src/core/staged.js";
import { pruneStaged, clearDiscovery } from "../src/core/data.js";
import { mergeRemoteRows } from "../src/core/sync.js";

const root = process.cwd();

test("categories load: 8 pillars / 98 subcategories", () => {
  const cats = loadCategories(join(root, "config", "categories.json"));
  assert.equal(Object.keys(cats.CATEGORY).length, 8);
  assert.equal(Object.keys(cats.SUBCATEGORY).length, 98);
  assert.equal(cats.CATEGORY.SCIENCE, "SCIENCE");
  assert.equal(cats.SUBCATEGORY.SPACE_ASTRONOMY, "SPACE_ASTRONOMY");
  assert.equal(cats.SUBCATEGORY_BY_CATEGORY.SCIENCE.length, 13);
});

test("stage storage adapter dedupes by URL", async () => {
  const cfg = getConfig();
  cfg.stagedDir = join(root, ".tmp-staged");
  rmSync(cfg.stagedDir, { recursive: true, force: true });
  const storage = await createStorage(cfg);
  const first = await storage.upsert([
    { url: "https://a.com/x", title: "X", source: "test" },
    { url: "https://a.com/y", title: "Y", source: "test" },
  ]);
  const second = await storage.upsert([
    { url: "https://a.com/x", title: "X", source: "test" },
    { url: "https://a.com/z", title: "Z", source: "test" },
  ]);
  assert.deepEqual(first, { inserted: 2, skipped: 0 });
  assert.deepEqual(second, { inserted: 1, skipped: 0 });
  rmSync(cfg.stagedDir, { recursive: true, force: true });
});

test("tagging prompt placeholders are substituted", () => {
  const prompt = readFileSync(join(root, "config", "tagging-prompt.txt"), "utf8");
  const out = buildPrompt(
    prompt,
    { title: "Hello", description: "Desc", url: "https://a.com" },
    { categories: [{ id: "SCIENCE", label: "Science" }], tags: ["news"] },
  );
  assert.ok(out.includes("Hello"));
  assert.ok(out.includes("SCIENCE (Science)"));
  assert.ok(out.includes("news"));
  assert.ok(!out.includes("{title}"));
});

test("categories externalId maps constants and grouping to external ids", () => {
  const dir = join(root, ".tmp-cat");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "categories.json");
  writeFileSync(file, JSON.stringify({
    categories: [{ id: "SCIENCE", label: "Science", externalId: "uuid-cat-1" }],
    subcategories: [
      { id: "SPACE_ASTRONOMY", category: "SCIENCE", externalId: "uuid-sub-1" },
      { id: "BIOLOGY_EVOLUTION", category: "SCIENCE", externalId: "uuid-sub-2" },
    ],
  }));
  const cats = loadCategories(file);
  assert.equal(cats.CATEGORY.SCIENCE, "uuid-cat-1");
  assert.equal(cats.SUBCATEGORY.SPACE_ASTRONOMY, "uuid-sub-1");
  assert.deepEqual(cats.SUBCATEGORY_BY_CATEGORY["uuid-cat-1"], ["uuid-sub-1", "uuid-sub-2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("aggregateRows counts by source/category/subcategory with percentages", () => {
  const rows = [
    { url: "1", source: "s1", category_id: "SCIENCE", subcategory_id: "SPACE_ASTRONOMY", language: "en" },
    { url: "2", source: "s1", category_id: "SCIENCE", subcategory_id: "BIOLOGY_EVOLUTION", language: "en" },
    { url: "3", source: "s2", category_id: "TECHNOLOGY", subcategory_id: "PROGRAMMING_SOFTWARE", language: "en" },
    { url: "4", source: "s2", category_id: "TECHNOLOGY", subcategory_id: "PROGRAMMING_SOFTWARE", language: "fr" },
  ];
  const stats = aggregateRows(rows);
  assert.equal(stats.total, 4);
  assert.equal(stats.seeders, 2);
  const src = Object.fromEntries(stats.bySource.map((r) => [r.key, r]));
  assert.equal(src.s1.count, 2);
  assert.equal(src.s1.pct, 50);
  const cat = Object.fromEntries(stats.byCategory.map((r) => [r.key, r]));
  assert.equal(cat.SCIENCE.count, 2);
  assert.equal(cat.TECHNOLOGY.count, 2);
});

test("mergeRows dedups by url (first writer wins)", () => {
  const a = [{ url: "https://a.com/x", title: "first" }];
  const b = [{ url: "https://a.com/x", title: "second" }, { url: "https://a.com/y", title: "y" }];
  const merged = mergeRows([a, b]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.url === "https://a.com/x").title, "first");
});

test("filterRows selects by source/category/date", () => {
  const rows = [
    { url: "1", source: "a", category_id: "SCIENCE", staged_at: "2026-01-01T00:00:00Z" },
    { url: "2", source: "b", category_id: "TECHNOLOGY", staged_at: "2026-06-01T00:00:00Z" },
  ];
  assert.equal(filterRows(rows, { source: "a" }).length, 1);
  assert.equal(filterRows(rows, { category: "TECHNOLOGY" }).length, 1);
  assert.equal(filterRows(rows, { before: "2026-03-01T00:00:00Z" }).length, 1);
  assert.equal(filterRows(rows, { after: "2026-03-01T00:00:00Z" }).length, 1);
});

test("pruneStaged soft-deletes matching rows and rewrites the source file", () => {
  const cfg = getConfig();
  cfg.stagedDir = join(root, ".tmp-prune-staged");
  cfg.dataDir = join(root, ".tmp-prune-data");
  rmSync(cfg.stagedDir, { recursive: true, force: true });
  rmSync(cfg.dataDir, { recursive: true, force: true });
  writeStagedSource("s1", [
    { url: "https://a.com/old", title: "old", source: "s1", staged_at: "2026-01-01T00:00:00Z" },
    { url: "https://a.com/new", title: "new", source: "s1", staged_at: "2026-01-03T00:00:00Z" },
  ]);
  const r = pruneStaged({ source: "s1", before: "2026-01-02T00:00:00Z" });
  assert.equal(r.deleted, 1);
  assert.equal(r.kept, 1);
  assert.ok(r.archived);
  const remaining = readStaged({ source: "s1" });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].url, "https://a.com/new");
  rmSync(cfg.stagedDir, { recursive: true, force: true });
  rmSync(cfg.dataDir, { recursive: true, force: true });
});

test("mergeRemoteRows merges peer rows with URL dedup", () => {
  const cfg = getConfig();
  cfg.stagedDir = join(root, ".tmp-merge-staged");
  rmSync(cfg.stagedDir, { recursive: true, force: true });
  writeStagedSource("local", [{ url: "https://a.com/x", title: "x", source: "local" }]);
  const r = mergeRemoteRows([
    { url: "https://a.com/x", title: "x2", source: "remote" },
    { url: "https://a.com/y", title: "y", source: "remote" },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.total, 2);
  rmSync(cfg.stagedDir, { recursive: true, force: true });
});

test("clearDiscovery removes a source's discovery cache", () => {
  const cfg = getConfig();
  cfg.dataDir = join(root, ".tmp-clear-data");
  rmSync(cfg.dataDir, { recursive: true, force: true });
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(join(cfg.dataDir, "example.json"), "{}");
  assert.equal(clearDiscovery("example").cleared, true);
  assert.equal(existsSync(join(cfg.dataDir, "example.json")), false);
  rmSync(cfg.dataDir, { recursive: true, force: true });
});
