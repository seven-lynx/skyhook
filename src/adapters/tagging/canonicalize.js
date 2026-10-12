/**
 * canonicalize.js — Snap an LLM-emitted tag slug to the nearest canonical tag
 * slug from the vocabulary. (Migrated from Roam's lib/canonicalize-tags.mjs.)
 *
 * The LLM often gets the concept right but not the exact slug (e.g.
 * "astronomy" instead of "space-astronomy", "art" instead of "visual-art").
 * This canonicalizer maps such near-misses onto the canonical slug so they
 * aren't dropped by the vocabulary check. Returns null when no confident
 * match exists (ambiguous or too-generic tags are left unmapped).
 */

// Curated synonym aliases: LLM output → canonical slug.
const ALIASES = {
  "astronomy": "space-astronomy",
  "exercise": "fitness",
  "security": "cybersecurity",
  "software-engineering": "programming",
  "ai": "artificial-intelligence",
  "coding": "programming",
  "gaming": "video-games",
  "art": "visual-art",
  "fine-art": "visual-art",
  "fine-arts": "visual-art",
  "aws": "cloud-computing",
  "beer-review": "craft-beer",
  "unsolved-murders": "unsolved-mysteries",
  "language-learning": "languages",
  "plants": "botany",
  "university": "education",
  "teaching": "education",
  "winter-sports": "sports",
  "skiing": "sports",
  "snowboarding": "sports",
  "parkour": "sports",
  "self-defense": "martial-arts",
  "combat-sports": "mma",
  "watches": "collecting",
  "indian-cuisine": "food-culture",
  "childrens-books": "literature",
  "movie": "film",
  "movies": "film",
};

// Generic / pillar-root words that are too vague to be a tag — always drop.
const BLOCKLIST = new Set([
  "technology", "science", "nature", "arts", "culture", "history",
  "ideas", "games", "hobbies", "weird", "wonderful", "people", "places",
  "mind", "body", "media", "news", "world", "business", "health",
]);

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u00C0-\u024F]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function bigrams(s) {
  const g = new Set();
  const str = " " + s + " ";
  for (let i = 0; i < str.length - 1; i++) g.add(str.slice(i, i + 2));
  return g;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function canonicalizeTag(rawTag, canonicalSlugs) {
  const norm = slugify(rawTag);
  if (!norm) return null;
  const slugs = Array.isArray(canonicalSlugs) ? canonicalSlugs : [...canonicalSlugs];

  // 1. Exact (normalized) match
  if (slugs.includes(norm)) return norm;

  // 2. Curated alias
  if (ALIASES[norm]) return ALIASES[norm];

  // 3. Blocklist — pillar roots / generic words are never tags
  if (BLOCKLIST.has(norm)) return null;

  // 4. Whole-word token match — only when unambiguous
  const tokenMatches = slugs.filter((s) => s.split("-").includes(norm));
  if (tokenMatches.length === 1) return tokenMatches[0];
  if (tokenMatches.length > 1) return null; // ambiguous — drop

  // 5. Reverse-token match — a token of the tag is itself a canonical slug
  //    (or a singular/plural form), e.g. "american-literature" → "literature",
  //    "history-museum" → "museums".
  {
    const tokens = norm.split("-").filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      if (slugs.includes(token)) return token;
      const variants = [];
      if (token.endsWith("s")) variants.push(token.slice(0, -1));
      else variants.push(token + "s");
      if (token.endsWith("es")) variants.push(token.slice(0, -2));
      for (const v of variants) {
        if (slugs.includes(v)) return v;
      }
    }
  }

  // 6. Fuzzy bigram match — spelling variants only (close-length guard)
  let best = null;
  let bestScore = 0;
  for (const s of slugs) {
    if (Math.abs(norm.length - s.length) > 2) continue;
    const d = dice(norm, s);
    if (d > bestScore) {
      bestScore = d;
      best = s;
    }
  }
  return bestScore >= 0.75 ? best : null;
}

export function canonicalizeTagList(tags, canonicalSlugs, onRemap) {
  const slugs = Array.isArray(canonicalSlugs) ? canonicalSlugs : [...canonicalSlugs];
  const out = [];
  for (const t of tags || []) {
    if (!t || typeof t.slug !== "string") continue;
    if (typeof t.confidence !== "number" || t.confidence < 0 || t.confidence > 1) continue;
    if (slugs.includes(t.slug)) { out.push(t); continue; }
    const canonical = canonicalizeTag(t.slug, slugs);
    if (canonical) {
      if (onRemap) onRemap(t.slug, canonical);
      out.push({ ...t, slug: canonical });
    }
  }
  return out;
}