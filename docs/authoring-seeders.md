# Authoring Seeders

A **seeder** is a single `seeders/seed-<slug>.js` file. Skyhook discovers it
automatically — no registry to edit, no rebuild.

## Template

```js
/**
 * seed-example.js — Example Site seeder
 * Category: CATEGORY.TECHNOLOGY → SUBCATEGORY.PROGRAMMING_SOFTWARE
 * Access: RSS feed → Sitemap → Wayback
 * Description: A minimal example seeder.
 */
import { seedRssWithFallbacks, CATEGORY, SUBCATEGORY } from "skyhook";

await seedRssWithFallbacks({
  siteDomain: "example.com",
  cacheFileName: "example.json",
  displayName: "Example",
  articlePathRegex: /\/(articles|news|features)\/[a-z0-9-]/i,
  siteSuffixRegex: /\s*\|\s*Example$/i,
  category_id: CATEGORY.TECHNOLOGY,
  subcategory_id: SUBCATEGORY.PROGRAMMING_SOFTWARE,
  source: "example",
  seeder_score: 0.7,
});
```

The JSDoc header is what the engine reads for the GUI/TUI/CLI listing:
- `Category: CATEGORY.X → SUBCATEGORY.Y` — taxonomy reference.
- `Access: …` — how the seeder finds URLs.
- `Description: …` — one-line summary (shown in the GUI).

## Config fields (`seedRssWithFallbacks`)

| Field | Required | Meaning |
|---|---|---|
| `siteDomain` | ✅ | Root host (e.g. `example.com`) |
| `cacheFileName` | ✅ | Per-source discovery cache filename |
| `displayName` | ✅ | Human name |
| `articlePathRegex` | ✅ | Which URL paths count as articles |
| `siteSuffixRegex` | ✅ | Site-name suffix to strip from titles |
| `category_id` / `subcategory_id` | ✅ | Taxonomy refs (`CATEGORY.X` / `SUBCATEGORY.Y`) |
| `source` | ✅ | Stable slug (defaults to the filename) |
| `feedUrl` | — | Explicit RSS/Atom feed |
| `seeder_score` | — | 0.0–1.0 quality hint (default 0.7) |
| `maxArticles` | — | Cap on URLs (default 2000) |

## Discovery chain

`seedRssWithFallbacks` runs these tiers and merges results (deduped by URL):

1. Configured RSS/Atom feed
2. RSS common paths (`/feed/`, `/rss/`, …)
3. JSON Feed (`/feed.json`)
4. `robots.txt` + sitemap
5. WordPress REST API
6. Wayback CDX API
7. RSS autodiscovery
8. Archive-page scraping
9. Headless browser (Crawlee + Playwright)

CLI flags accepted by any seeder: `--no-cache`, `--aggressive`, `--with-headless`,
`--stage-only`, `--max-age-days N`.

## Categories

The taxonomy lives in `config/categories.json` (8 pillars / 98 subcategories by
default). `CATEGORY` and `SUBCATEGORY` are generated from it. Add `externalId` to
map a string id onto your database's own ids:

```json
{ "id": "SCIENCE", "label": "Science & Nature", "externalId": "c1000000-…" }
```

For a fully custom seeder (non-RSS source), import `upsertUrls` from `skyhook`
and push your own rows — see the `src/core/seed.js` header for the row shape.
