/**
 * tasks.js — Config-driven LLM task definitions for filling missing info in the
 * offline SQLite DB. Each task has a key, label, a prompt file, a SQL filter for
 * selecting eligible URLs, and a write target. Used by the offline tag worker and
 * the API/GUI to run targeted LLM passes.
 */
import { existsSync, readFileSync } from "fs";
import { join, isAbsolute, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { getConfig } from "../../config.js";
import { loadText } from "./index.js";

// Absolute path to the skyhook package root. Shipped task prompts live in
// <package>/config/prompts/ and must resolve relative to the package, not the
// process cwd (which for the Roam overlay is roam/, not the package dir).
const PACKAGE_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const prompt = (rel) => join(PACKAGE_ROOT, rel);

const DEFAULT_TASKS = [
  {
    key: "fill-category", label: "Fill missing categories", gap: "category",
    promptFile: prompt("config/prompts/fill-category.md"),
    filterClause: "AND u.category_id IS NULL",
    target: "category", resumeSource: "task:fill-category",
  },
  {
    key: "fill-subcategory", label: "Fill missing subcategories", gap: "subcategory",
    promptFile: prompt("config/prompts/fill-subcategory.md"),
    filterClause: "AND u.subcategory_id IS NULL AND u.category_id IS NOT NULL",
    target: "subcategory", resumeSource: "task:fill-subcategory",
  },
  {
    key: "fill-tags", label: "Add tags to untagged URLs", gap: "tags",
    promptFile: null,
    filterClause: "AND u.id NOT IN (SELECT url_id FROM local_url_tags)",
    target: "tags", resumeSource: "task:fill-tags",
  },
  {
    key: "fill-content-type", label: "Fill missing content types", gap: "contentType",
    promptFile: prompt("config/prompts/fill-content-type.md"),
    filterClause: `AND (u.id NOT IN (SELECT url_id FROM local_url_attributes) OR u.id IN (SELECT url_id FROM local_url_attributes WHERE content_type IS NULL))`,
    target: "contentType", resumeSource: "task:fill-content-type",
  },
  {
    key: "fill-quality", label: "Fill missing quality assessments", gap: "quality",
    promptFile: prompt("config/prompts/fill-quality.md"),
    filterClause: `AND (u.id NOT IN (SELECT url_id FROM local_url_quality) OR u.id IN (SELECT url_id FROM local_url_quality WHERE quality_score IS NULL))`,
    target: "quality", resumeSource: "task:fill-quality",
  },
  {
    key: "fill-attributes", label: "Fill missing attributes", gap: "attributes",
    promptFile: prompt("config/prompts/fill-attributes.md"),
    filterClause: `AND (u.id NOT IN (SELECT url_id FROM local_url_attributes) OR u.id IN (SELECT url_id FROM local_url_attributes WHERE audience_level IS NULL))`,
    target: "attributes", resumeSource: "task:fill-attributes",
  },

  // Recheck every URL, including ones already filled (reprocess bypasses the
  // "already tagged by this run" exclusion).
  {
    key: "recheck-category", label: "Recheck all categories",
    promptFile: prompt("config/prompts/fill-category.md"),
    filterClause: "", target: "category", resumeSource: "task:recheck-category", reprocess: true,
  },
  {
    key: "recheck-subcategory", label: "Recheck all subcategories",
    promptFile: prompt("config/prompts/fill-subcategory.md"),
    filterClause: "AND u.category_id IS NOT NULL",
    target: "subcategory", resumeSource: "task:recheck-subcategory", reprocess: true,
  },
  {
    key: "recheck-tags", label: "Recheck tags on all URLs",
    promptFile: null,
    filterClause: "", target: "tags", resumeSource: "task:recheck-tags", reprocess: true,
  },
  {
    key: "recheck-content-type", label: "Recheck all content types",
    promptFile: prompt("config/prompts/fill-content-type.md"),
    filterClause: "", target: "contentType", resumeSource: "task:recheck-content-type", reprocess: true,
  },
  {
    key: "recheck-quality", label: "Recheck all quality assessments",
    promptFile: prompt("config/prompts/fill-quality.md"),
    filterClause: "", target: "quality", resumeSource: "task:recheck-quality", reprocess: true,
  },
  {
    key: "recheck-attributes", label: "Recheck all attributes",
    promptFile: prompt("config/prompts/fill-attributes.md"),
    filterClause: "", target: "attributes", resumeSource: "task:recheck-attributes", reprocess: true,
  },

  // Recheck only URLs whose existing fill was low-confidence.
  {
    key: "recheck-low-confidence-attributes", label: "Recheck low-confidence attributes",
    promptFile: prompt("config/prompts/fill-attributes.md"),
    filterClause: "AND u.id IN (SELECT url_id FROM local_url_attributes WHERE confidence IS NOT NULL AND confidence < 0.7)",
    target: "attributes", resumeSource: "task:recheck-low-confidence-attributes", reprocess: true,
  },
  {
    key: "recheck-low-confidence-quality", label: "Recheck low-confidence quality",
    promptFile: prompt("config/prompts/fill-quality.md"),
    filterClause: "AND u.id IN (SELECT url_id FROM local_url_quality WHERE confidence IS NOT NULL AND confidence < 0.7)",
    target: "quality", resumeSource: "task:recheck-low-confidence-quality", reprocess: true,
  },

  // Add tags to URLs that have fewer than minTags tags (configurable).
  {
    key: "fill-tags-sparse", label: "Add tags to URLs with few tags",
    promptFile: null,
    filterClause: "", target: "tags", resumeSource: "task:fill-tags-sparse", minTags: 3,
  },
];

export function getTasks() {
  const cfg = getConfig();
  return cfg.tagging?.tasks?.length ? cfg.tagging.tasks : DEFAULT_TASKS;
}

export function getTask(key) {
  return getTasks().find((t) => t.key === key) || null;
}

export function loadTaskPromptFile(task) {
  if (!task || !task.promptFile) return null;
  // Shipped default prompts are absolute (package-rooted); config-overridden
  // prompts are cwd-relative, matching config.js's tagging.promptFile handling.
  const file = isAbsolute(task.promptFile) ? task.promptFile : join(process.cwd(), task.promptFile);
  const raw = loadText(file);
  if (!raw) return null;
  const marker = "## System Prompt";
  const idx = raw.indexOf(marker);
  return (idx === -1 ? raw : raw.slice(idx + marker.length)).trim();
}

export function buildTaskUserMessage(urls, task) {
  const instructions = {
    category: "Assign a category to each: TECHNOLOGY, SCIENCE, ARTS_AND_CULTURE, HISTORY_AND_IDEAS, GAMES_AND_HOBBIES, WEIRD_AND_WONDERFUL, PEOPLE_AND_PLACES, MIND_AND_BODY, or \"unknown\".\n\n",
    subcategory: "Choose the best subcategory from the vocabulary. Return \"unknown\" if none fits.\n\n",
    tags: "Assign 2-5 relevant tags from the vocabulary.\n\n",
    contentType: "Classify content_type: article, research, tutorial, review, opinion, news, reference, gallery, interactive, or other.\n\n",
    quality: "Assess url_type, quality_score (0-1), and boolean flags.\n\n",
    attributes: "Determine audience_level, depth, tone, and is_news.\n\n",
  };
  let msg = (instructions[task.target] || "Analyze each URL.\n\n");
  urls.forEach((u, i) => {
    msg += `[URL ${i}]\nTitle: ${u.title || ""}\nDescription: ${u.description || ""}\n\n`;
  });
  return msg;
}
function extractJson(text) {
  const t = String(text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return body.slice(start, end + 1);
}

export function parseTaskResponse(raw, urlCount, task) {
  const parsed = JSON.parse(extractJson(raw));
  const urlResults = Array.isArray(parsed.results) ? parsed.results : (Array.isArray(parsed) ? parsed : []);
  const results = [];
  for (const r of urlResults) {
    const idx = r.url_index;
    if (idx === undefined || idx >= urlCount) continue;
    const out = { url_index: idx };
    switch (task.target) {
      case "category":
        out.category = String(r.category || "").toUpperCase();
        out.confidence = typeof r.confidence === "number" ? r.confidence : 0.5;
        break;
      case "subcategory":
        out.subcategory = String(r.subcategory || "").toUpperCase();
        out.confidence = typeof r.confidence === "number" ? r.confidence : 0.5;
        break;
      case "tags": {
        const tags = (Array.isArray(r.tags) ? r.tags : []).map((t) =>
          typeof t === "string" ? { slug: t.toLowerCase().replace(/\s+/g, "-"), confidence: 0.7 } : t
        );
        out.tags = tags;
        break;
      }
      case "contentType":
        out.contentType = String(r.content_type || "other").toLowerCase();
        out.confidence = typeof r.confidence === "number" ? r.confidence : 0.5;
        break;
      case "quality":
        out.url_type = String(r.url_type || "other").toLowerCase();
        out.quality_score = typeof r.quality_score === "number" ? Math.max(0, Math.min(1, r.quality_score)) : 0.5;
        out.is_parked = !!r.is_parked; out.is_product = !!r.is_product;
        out.is_spam = !!r.is_spam; out.is_paywalled = !!r.is_paywalled;
        out.is_login_required = !!r.is_login_required; out.is_broken = !!r.is_broken;
        out.is_thin = !!r.is_thin; out.is_clickbait = !!r.is_clickbait;
        out.is_english = r.is_english !== false;
        out.confidence = typeof r.confidence === "number" ? r.confidence : 0.5;
        break;
      case "attributes":
        out.audience_level = String(r.audience_level || "general").toLowerCase();
        out.depth = String(r.depth || "medium").toLowerCase();
        out.tone = String(r.tone || "neutral").toLowerCase();
        out.is_news = !!r.is_news;
        out.confidence = typeof r.confidence === "number" ? r.confidence : 0.5;
        break;
    }
    results.push(out);
  }
  return results;
}
export function countMissingSync(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return { offlineDb: false, missing: null, total: 0 };
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (sql) => { try { return db.prepare(sql).get().c ?? 0; } catch { return null; } };
    const total = count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != ''`);
    const missing = {
      category: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND category_id IS NULL`),
      subcategory: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND subcategory_id IS NULL AND category_id IS NOT NULL`),
      tags: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND id NOT IN (SELECT url_id FROM local_url_tags)`),
      contentType: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND (id NOT IN (SELECT url_id FROM local_url_attributes) OR id IN (SELECT url_id FROM local_url_attributes WHERE content_type IS NULL))`),
      quality: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND (id NOT IN (SELECT url_id FROM local_url_quality) OR id IN (SELECT url_id FROM local_url_quality WHERE quality_score IS NULL))`),
      attributes: count(`SELECT COUNT(*) c FROM urls WHERE approved = 1 AND inactive = 0 AND title IS NOT NULL AND title != '' AND (id NOT IN (SELECT url_id FROM local_url_attributes) OR id IN (SELECT url_id FROM local_url_attributes WHERE audience_level IS NULL))`),
    };
    return { offlineDb: true, missing, total };
  } finally { db.close(); }
}