/**
 * storage/stage.js — offline JSONL staging adapter (no external DB).
 *
 * The default provider. Writes one JSONL file per `source` into `stagedDir`,
 * idempotent by URL. Perfect for air-gapped machines (e.g. a Raspberry Pi) —
 * pull the staged files to a machine with DB access to `push` them later.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { registerStorage } from "./index.js";

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);

registerStorage("stage", async (config) => {
  const stagedDir = config.stagedDir || join(config.dataDir, "staged");
  mkdirSync(stagedDir, { recursive: true });

  return {
    provider: "stage",
    // Staging is the source of truth for "existing"; dedup happens in upsert().
    async findExisting() {
      return new Set();
    },
    async upsert(rows) {
      const bySource = new Map();
      for (const r of rows) {
        const src = r.source || "manual";
        if (!bySource.has(src)) bySource.set(src, []);
        bySource.get(src).push(r);
      }
      let staged = 0;
      for (const [src, group] of bySource) {
        const file = join(stagedDir, `${safe(src)}.jsonl`);
        const existing = new Set();
        if (existsSync(file)) {
          for (const line of readFileSync(file, "utf8").split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try { existing.add(JSON.parse(t).url); } catch { /* skip malformed */ }
          }
        }
        const lines = [];
        for (const r of group) {
          if (existing.has(r.url)) continue;
          existing.add(r.url);
          lines.push(JSON.stringify({ ...r, staged_at: new Date().toISOString() }));
        }
        if (lines.length) {
          appendFileSync(file, lines.join("\n") + "\n", "utf8");
          staged += lines.length;
        }
      }
      return { inserted: staged, skipped: 0 };
    },
  };
});
