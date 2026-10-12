/**
 * seed-hackernews.js — Hacker News seeder
 * Category: CATEGORY.TECHNOLOGY → SUBCATEGORY.PROGRAMMING_SOFTWARE
 * Access: RSS feed
 * Description: Front-page links from news.ycombinator.com.
 */
import { seedRssWithFallbacks, CATEGORY, SUBCATEGORY } from "skyhook";

await seedRssWithFallbacks({
  siteDomain: "news.ycombinator.com",
  cacheFileName: "hackernews.json",
  displayName: "Hacker News",
  feedUrl: "https://news.ycombinator.com/rss",
  articlePathRegex: /\/item\?id=\d+/i,
  siteSuffixRegex: /\s*\|\s*Hacker News$/i,
  category_id: CATEGORY.TECHNOLOGY,
  subcategory_id: SUBCATEGORY.PROGRAMMING_SOFTWARE,
  source: "hackernews",
  seeder_score: 0.7,
});
