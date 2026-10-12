/**
 * seed-lobsters.js — Lobsters seeder
 * Category: CATEGORY.TECHNOLOGY → SUBCATEGORY.OPEN_SOURCE
 * Access: RSS feed
 * Description: Technology links from lobste.rs.
 */
import { seedRssWithFallbacks, CATEGORY, SUBCATEGORY } from "skyhook";

await seedRssWithFallbacks({
  siteDomain: "lobste.rs",
  cacheFileName: "lobsters.json",
  displayName: "Lobsters",
  feedUrl: "https://lobste.rs/rss",
  articlePathRegex: /\/s\/[a-z0-9]+\/[a-z0-9_-]+/i,
  siteSuffixRegex: /\s*\|\s*Lobsters$/i,
  category_id: CATEGORY.TECHNOLOGY,
  subcategory_id: SUBCATEGORY.OPEN_SOURCE,
  source: "lobsters",
  seeder_score: 0.7,
});
