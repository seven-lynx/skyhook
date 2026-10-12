import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadCategories } from "../src/adapters/categories/index.js";
import { createStorage } from "../src/adapters/storage/index.js";
import { buildPrompt } from "../src/adapters/tagging/index.js";
import { getConfig } from "../src/config.js";

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
