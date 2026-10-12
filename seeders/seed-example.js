/**
 * seed-example.js — Example Site seeder
 * Category: CATEGORY.TECHNOLOGY → SUBCATEGORY.PROGRAMMING_SOFTWARE
 * Access: RSS feed → Sitemap → Wayback
 * Description: A minimal example seeder (template for your own sites).
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
