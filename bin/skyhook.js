#!/usr/bin/env node
/**
 * skyhook.mjs — Skyhook Control Center (CLI).
 *
 * One entry point for ALL seeding management: browse the 606 seeders, see what
 * is due, run seeders, edit the schedule, inspect history, and regenerate the
 * systemd timer. Runs identically on the Raspberry Pi and the PC.
 *
 *   skyhook --help          # list all commands
 *   skyhook help <command>  # help for one command
 *   skyhook list            # full schedule + last-run + result
 *   skyhook run nyt guardian
 *   skyhook run-due --force
 *   skyhook schedule nyt daily --is-news --max-age-days 180
 */
import {
  buildIndex, openState, getState, listRuns, isDue, runPool, dueSeeders,
  editManifest, enableSeeder, disableSeeder, resolveSeeder, emitTimer, writeTimer,
  CADENCES, CADENCE_MS, LOGS_DIR, SCRIPTS_DIR,
} from "../src/engine/seeder-engine.js";
import { nodeId } from "../src/config.js";
import { routeSeeders, peerFor, runRemote, getPeers, pullStaged } from "../src/core/remote.js";
import { settingsView, saveSettings } from "../src/core/settings.js";
import { statsFromStaged } from "../src/core/analytics.js";
import { listCache, pruneStaged, clearDiscovery, clearStaged } from "../src/core/data.js";
import { mergeRemoteRows, pushStagedToStorage } from "../src/core/sync.js";
import { spawnSync } from "child_process";
import { join } from "path";

const COMMANDS = [
  ["list",       "Show all seeders with schedule, last run, result, and next run"],
  ["status",     "Alias for list"],
  ["due",        "List seeders that are due to run now"],
  ["run",        "Run one or more specific seeders now"],
  ["run-due",    "Run every seeder that is due (the scheduled/systemd action)"],
  ["schedule",   "View or change a seeder's cadence / tier / max age"],
  ["enable",     "Add a seeder to the schedule (opt it in)"],
  ["disable",    "Remove a seeder from the schedule (make it manual)"],
  ["history",    "Show a seeder's recent run history"],
  ["validate",   "Validate seeder category/subcategory wiring (needs Supabase)"],
  ["emit-timer", "Regenerate the systemd timer from the fastest enabled cadence"],
  ["stats",      "Analytics: total URLs + per-seeder/category/subcategory percentages"],
  ["cache",      "Inspect / prune staged results and discovery cache (delete URLs)"],
  ["sync",       "Merge staged results with a peer (Pi ⇄ PC) with URL dedup"],
  ["push",       "Push the merged staged set into the configured storage"],
  ["settings",   "View or toggle node settings (allowRemote, peers)"],
  ["tui",        "Interactive menu (terminal control center)"],
  ["serve",      "Start the HTTP JSON API (for the GUI / remote control)"],
  ["help",       "Show help (help <cmd> for one command)"],
];

function usage() {
  const w = Math.max(...COMMANDS.map((c) => c[0].length));
  let out = "Skyhook Control Center\n\nUsage: skyhook <command> [options]\n\nCommands:\n";
  for (const [name, desc] of COMMANDS) out += `  ${name.padEnd(w)}  ${desc}\n`;
  out += `\nGlobal: --help  Show this help\n`;
  out += `Cadence values: ${CADENCES.join(" | ")}\n`;
  console.log(out);
}

function helpFor(cmd) {
  const entry = COMMANDS.find((c) => c[0] === cmd);
  if (!entry) { console.error(`Unknown command: ${cmd}`); usage(); process.exit(2); }
  const [name, desc] = entry;
  console.log(`${name} — ${desc}\n`);
  const details = {
    list:      "list [--filter <substr>] [--tier news|evergreen] [--due] [--errors] [--scheduled] [--manual] [--limit N]",
    status:    "Same as list.",
    due:       "due [--tier news|evergreen]",
    run:       "run <source|script|substring> [...] [--parallel N] [--with-headless] [--aggressive] [--force-headless] [--no-cache]",
    "run-due": "run-due [--tier news|evergreen] [--source X] [--force] [--parallel N] [--with-headless] [--aggressive] [--force-headless] [--no-cache] [--dry-run]",
    schedule:  "schedule <query> <cadence> [--is-news] [--max-age-days N]  |  schedule <query>  (view)",
    enable:    "enable <query> [--cadence weekly]",
    disable:   "disable <query>",
    history:   "history <query> [--limit N]",
    validate:  "validate [--json] [--verbose]",
    "emit-timer": "emit-timer [--dry-run]",
    stats:      "stats [--source <slug>]",
    cache:      "cache                          (list staged + discovery cache)  |  cache prune [--source X] [--category Y] [--subcategory Z] [--before DATE] [--after DATE] [--url U] [--hard]  |  cache clear <source> [--discovery] [--hard]",
    sync:       "sync pull <peer-id>            (merge a peer's staged results locally)  |  sync peers (list peers)",
    push:       "push",
    settings:   "settings                       (view)  |  settings allow-remote on|off",
    tui: "tui",
    serve:     "serve [--port N]  (default 4173)",
    help:      "help [<command>]",
  };
  console.log(`Usage: skyhook ${details[name] ?? name}`);
  console.log(`\nRun 'skyhook help <command>' for more.`);
}

// ── arg helpers ─────────────────────────────────────────────────────────────
function has(a, f) { return a.includes(f); }
function val(a, f, dflt) {
  const eq = a.find((x) => x.startsWith(f + "="));
  if (eq) return eq.slice(f.length + 1);
  const i = a.indexOf(f);
  if (i === -1) return dflt;
  const v = a[i + 1];
  return v && !v.startsWith("--") ? v : dflt;
}

function fmtAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m ago";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtDur(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtResult(json) {
  if (!json) return "";
  try {
    const r = JSON.parse(json);
    return `+${r.staged ?? 0} -${r.dead ?? 0} skip${r.skipped ?? 0}`;
  } catch { return ""; }
}

function fmtNext(iso) {
  if (!iso) return "—";
  return fmtAgo(iso).replace(" ago", " from now").replace("never", "—");
}

const tierOf = (s) => (s.isNews ? "news" : "evergreen");
const catOf = (s) => (s.subcategoryLabel ? `${s.subcategoryLabel}` : (s.categoryLabel ?? "—"));

function fmtIn(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  if (ms < 3600e3) return `in ${Math.round(ms / 60000)}m`;
  if (ms < 24 * 3600e3) return `in ${Math.round(ms / 3600e3)}h`;
  return `in ${Math.round(ms / (24 * 3600e3))}d`;
}

// ── list / status ───────────────────────────────────────────────────────────
function cmdList(a) {
  const idx = buildIndex();
  const db = openState();
  const filter = val(a, "--filter", null);
  const tier = val(a, "--tier", null);
  const onlyDue = has(a, "--due");
  const onlyErrors = has(a, "--errors");
  const onlyScheduled = has(a, "--scheduled");
  const onlyManual = has(a, "--manual");
  const limit = parseInt(val(a, "--limit", "0"), 10) || 0;

  let rows = idx;
  if (filter) {
    const f = filter.toLowerCase();
    rows = rows.filter((s) =>
      s.source.toLowerCase().includes(f) ||
      s.script.includes(f) ||
      (s.displayName || "").toLowerCase().includes(f) ||
      (s.category || "").toLowerCase().includes(f));
  }
  if (tier === "news") rows = rows.filter((s) => s.isNews);
  if (tier === "evergreen") rows = rows.filter((s) => !s.isNews);
  if (onlyScheduled) rows = rows.filter((s) => s.scheduled);
  if (onlyManual) rows = rows.filter((s) => !s.scheduled);

  let enriched = rows.map((s) => {
    const st = getState(db, s.source);
    return { s, st, due: isDue(s, st) };
  });
  if (onlyDue) enriched = enriched.filter((r) => r.due);
  if (onlyErrors) enriched = enriched.filter((r) => r.st && r.st.last_status && r.st.last_status !== "ok");
  if (limit) enriched = enriched.slice(0, limit);

  const nErr = enriched.filter((r) => r.st && r.st.last_status && r.st.last_status !== "ok").length;
  console.log(`\nSeeders: ${enriched.length} shown  ·  total ${idx.length}  ·  scheduled ${idx.filter((s) => s.scheduled).length}  ·  due ${enriched.filter((r) => r.due).length}  ·  errors ${nErr}${filter ? `  ·  filter "${filter}"` : ""}\n`);

  const cols = { source: "SOURCE", cadence: "CADENCE", tier: "TIER", cat: "CATEGORY", last: "LAST RUN", res: "RESULT", next: "NEXT" };
  const data = enriched.map((r) => ({
    source: r.s.source,
    cadence: r.s.cadence,
    tier: tierOf(r.s),
    cat: catOf(r.s),
    last: r.st?.last_run_at ? `${fmtAgo(r.st.last_run_at)}${r.st.last_status && r.st.last_status !== "ok" ? " ❌" : ""}` : "never",
    res: r.st ? fmtResult(r.st.last_result) : "",
    next: r.s.cadence === "manual" ? "manual" : (r.st?.next_run_at ? fmtIn(r.st.next_run_at) : "now"),
  }));
  const w = (key, min) => Math.max(min, cols[key].length, ...data.map((d) => d[key].length));
  const W = {
    source: w("source", 10), cadence: w("cadence", 8), tier: w("tier", 9),
    cat: Math.min(w("cat", 10), 32), last: w("last", 10), res: w("res", 10), next: w("next", 8),
  };
  const hdr = `${cols.source.padEnd(W.source)} ${cols.cadence.padEnd(W.cadence)} ${cols.tier.padEnd(W.tier)} ${cols.cat.padEnd(W.cat)} ${cols.last.padEnd(W.last)} ${cols.res.padEnd(W.res)} ${cols.next.padEnd(W.next)}`;
  console.log(hdr);
  console.log("─".repeat(hdr.length));
  for (const d of data) {
    const cat = d.cat.length > W.cat ? d.cat.slice(0, W.cat - 1) + "…" : d.cat;
    console.log(`${d.source.padEnd(W.source)} ${d.cadence.padEnd(W.cadence)} ${d.tier.padEnd(W.tier)} ${cat.padEnd(W.cat)} ${d.last.padEnd(W.last)} ${d.res.padEnd(W.res)} ${d.next.padEnd(W.next)}`);
  }
  db.close();
}

// ── due ─────────────────────────────────────────────────────────────────────
function cmdDue(a) {
  const tier = val(a, "--tier", "all");
  const { due, db } = dueSeeders({ tier });
  const w = Math.max(6, ...due.map((s) => s.source.length));
  console.log(`\nDue now (tier=${tier}): ${due.length}\n`);
  for (const s of due) {
    const st = getState(db, s.source);
    console.log(`  ${s.source.padEnd(w)}  ${s.cadence.padEnd(8)} ${tierOf(s).padEnd(9)} last: ${st?.last_run_at ? fmtAgo(st.last_run_at) : "never"}`);
  }
  if (!due.length) console.log("  (none — everything is within its cadence window)");
  console.log("");
  db.close();
}

// ── run ─────────────────────────────────────────────────────────────────────
function pickSeeders(queries, idx) {
  const selected = [];
  for (const q of queries) {
    const s = resolveSeeder(q, idx);
    if (!s) { console.error(`✗ No unique match for "${q}"`); return null; }
    selected.push(s);
  }
  return selected;
}

function printRunSummary(results) {
  const failed = results.filter((r) => r.status !== "ok");
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏁 Done. ${results.length - failed.length} ok, ${failed.length} failed.`);
  for (const r of results) {
    const res = r.result ? ` +${r.result.staged} -${r.result.dead}` : "";
    console.log(`  ${r.status === "ok" ? "✓" : "✗"} ${r.seeder.source.padEnd(22)} ${r.status}${res} (${fmtDur(r.durationMs)})`);
  }
  if (failed.length) for (const f of failed) console.log(`    ↳ ${f.error ?? ""}`);
  console.log("");
}

async function cmdRun(a) {
  const queries = a.filter((x) => !x.startsWith("--"));
  const parallel = Math.max(1, parseInt(val(a, "--parallel", "2"), 10) || 2);
  const withHeadless = has(a, "--with-headless");
  const aggressive = has(a, "--aggressive");
  const forceHeadless = has(a, "--force-headless");
  const noCache = has(a, "--no-cache");
  if (!queries.length) { console.error("No seeders specified.\nUsage: skyhook run <query> [...] [--parallel N]"); process.exitCode = 1; return; }
  const idx = buildIndex();
  const selected = pickSeeders(queries, idx);
  if (!selected) { process.exitCode = 1; return; }
  console.log(`\n▶ Running ${selected.length} seeder(s), concurrency=${parallel}...\n`);
  const { local, remote } = routeSeeders(selected);
  const results = [];
  if (local.length) {
    results.push(...(await runPool(local, { concurrency: parallel, withHeadless, aggressive, forceHeadless, noCache })));
  }
  for (const [peerId, seeders] of remote) {
    const peer = peerFor(peerId);
    if (!peer) { console.error(`✗ No peer configured for node "${peerId}"`); process.exitCode = 1; continue; }
    console.log(`↳ Forwarding ${seeders.length} seeder(s) to peer "${peerId}" (${peer.url})...`);
    try {
      await runRemote(peer, seeders, { concurrency: parallel, withHeadless, aggressive, forceHeadless, noCache });
      console.log(`  ✓ forwarded to ${peerId}`);
    } catch (err) {
      console.error(`  ✗ forward to ${peerId} failed: ${err.message}`);
      process.exitCode = 1;
    }
  }
  printRunSummary(results);
  if (results.some((r) => r.status !== "ok")) process.exitCode = 1;
}

// ── run-due ─────────────────────────────────────────────────────────────────
async function cmdRunDue(a) {
  const tier = val(a, "--tier", "all");
  const source = val(a, "--source", null);
  const force = has(a, "--force");
  const parallel = Math.max(1, parseInt(val(a, "--parallel", "2"), 10) || 2);
  const withHeadless = has(a, "--with-headless");
  const aggressive = has(a, "--aggressive");
  const forceHeadless = has(a, "--force-headless");
  const noCache = has(a, "--no-cache");
  const dryRun = has(a, "--dry-run");
  const node = val(a, "--node", null);
  const { due, db } = dueSeeders({ tier, source, force, node });

  if (dryRun) {
    console.log(`\n[dry-run] Would run ${due.length} seeder(s) (tier=${tier}${source ? `, source=${source}` : ""}${force ? ", forced" : ""}):\n`);
    for (const s of due) console.log(`  node ${SCRIPTS_DIR}/${s.script} --stage-only${s.maxAgeDays != null ? ` --max-age-days ${s.maxAgeDays}` : ""}`);
    console.log("");
    db.close();
    return;
  }
  if (!due.length) { console.log("\n✅ Nothing due. All seeders are within their cadence windows.\n"); db.close(); return; }

  console.log(`\n📅 Running ${due.length} seeder(s) (tier=${tier}${node ? `, node=${node}` : ""}, concurrency=${parallel}${force ? ", FORCED" : ""})...\n`);
  const { local, remote } = routeSeeders(due);
  const results = [];
  if (local.length) {
    results.push(...(await runPool(local, { concurrency: parallel, withHeadless, aggressive, forceHeadless, noCache })));
  }
  for (const [peerId, seeders] of remote) {
    const peer = peerFor(peerId);
    if (!peer) { console.error(`✗ No peer configured for node "${peerId}"`); process.exitCode = 1; continue; }
    console.log(`↳ Forwarding ${seeders.length} seeder(s) to peer "${peerId}"...`);
    try {
      await runRemote(peer, seeders, { concurrency: parallel, withHeadless, aggressive, forceHeadless, noCache });
      console.log(`  ✓ forwarded to ${peerId}`);
    } catch (err) {
      console.error(`  ✗ forward to ${peerId} failed: ${err.message}`);
      process.exitCode = 1;
    }
  }
  printRunSummary(results);
  db.close();
  if (results.some((r) => r.status !== "ok")) process.exitCode = 1;
}

// ── schedule ────────────────────────────────────────────────────────────────
function showScheduler(s) {
  console.log(`\n${s.displayName ?? s.source}\n`);
  console.log(`  source     ${s.source}`);
  console.log(`  script     ${s.script}`);
  console.log(`  scheduled  ${s.scheduled ? "yes" : "no (manual)"}`);
  console.log(`  cadence    ${s.cadence}`);
  console.log(`  tier       ${tierOf(s)}`);
  console.log(`  maxAgeDays ${s.maxAgeDays ?? "—"}`);
  console.log(`  node       ${s.node ?? "local"}${s.node && s.node !== nodeId() ? " (remote)" : ""}`);
  console.log(`  category   ${s.categoryLabel ?? "—"}${s.subcategoryLabel ? " → " + s.subcategoryLabel : ""}`);
  console.log(`  access     ${s.access ?? "—"}\n`);
}

function cmdSchedule(a) {
  const args = a.filter((x) => !x.startsWith("--"));
  const query = args[0];
  if (!query) { console.error("Usage: skyhook schedule <query> [<cadence>] [--is-news|--not-news] [--max-age-days N]"); process.exitCode = 1; return; }
  const idx = buildIndex();
  const s = resolveSeeder(query, idx);
  if (!s) { console.error(`✗ No unique match for "${query}"`); process.exitCode = 1; return; }

  if (!args[1]) { showScheduler(s); return; }

  const cadence = args[1];
  if (!(cadence in CADENCE_MS)) { console.error(`✗ Invalid cadence "${cadence}". Use: ${CADENCES.join(" | ")}`); process.exitCode = 1; return; }

  let isNews;
  if (has(a, "--is-news")) isNews = true;
  if (has(a, "--not-news")) isNews = false;
  let maxAgeDays;
  if (a.some((x) => x === "--max-age-days" || x.startsWith("--max-age-days="))) {
    const v = val(a, "--max-age-days", "");
    maxAgeDays = (v === "" || v === "null") ? null : Number(v);
  }
  let node;
  if (a.some((x) => x === "--node" || x.startsWith("--node="))) {
    const v = val(a, "--node", "");
    node = (v === "" || v === "null") ? null : v;
  }

  const entry = editManifest({ query, cadence, isNews, maxAgeDays, node });
  if (!entry) { console.error(`✗ Could not update schedule for "${query}"`); process.exitCode = 1; return; }
  console.log(`✓ ${entry.source}: cadence=${entry.cadence}${entry.isNews !== undefined ? ` tier=${entry.isNews ? "news" : "evergreen"}` : ""}${entry.maxAgeDays !== undefined ? ` maxAgeDays=${entry.maxAgeDays ?? "—"}` : ""}`);
  console.log("  Reminder: run `skyhook emit-timer` to refresh the systemd timer, and push the manifest to the Pi if editing from the PC.\n");
}

// ── enable / disable ────────────────────────────────────────────────────────
function cmdEnable(a) {
  const query = a.filter((x) => !x.startsWith("--"))[0];
  if (!query) { console.error("Usage: skyhook enable <query> [--cadence weekly]"); process.exitCode = 1; return; }
  const cadence = val(a, "--cadence", "weekly");
  if (!(cadence in CADENCE_MS)) { console.error(`✗ Invalid cadence "${cadence}". Use: ${CADENCES.join(" | ")}`); process.exitCode = 1; return; }
  const entry = enableSeeder(query, cadence);
  if (!entry) { console.error(`✗ No unique match for "${query}"`); process.exitCode = 1; return; }
  console.log(`✓ Enabled ${entry.source} (cadence=${entry.cadence}).`);
  console.log("  Reminder: `skyhook emit-timer` + push the manifest to the Pi.\n");
}

function cmdDisable(a) {
  const query = a.filter((x) => !x.startsWith("--"))[0];
  if (!query) { console.error("Usage: skyhook disable <query>"); process.exitCode = 1; return; }
  const s = disableSeeder(query);
  if (!s) { console.error(`✗ "${query}" is not scheduled (or not a unique match).`); process.exitCode = 1; return; }
  console.log(`✓ Disabled ${s.source} (now manual — still runnable on demand).\n`);
}

// ── history ─────────────────────────────────────────────────────────────────
function cmdHistory(a) {
  const query = a.filter((x) => !x.startsWith("--"))[0];
  if (!query) { console.error("Usage: skyhook history <query> [--limit N]"); process.exitCode = 1; return; }
  const limit = parseInt(val(a, "--limit", "10"), 10) || 10;
  const idx = buildIndex();
  const s = resolveSeeder(query, idx);
  if (!s) { console.error(`✗ No unique match for "${query}"`); process.exitCode = 1; return; }
  const db = openState();
  const runs = listRuns(db, s.source, limit);
  console.log(`\n${s.source} — last ${runs.length} run(s)\n`);
  if (!runs.length) { console.log("  (no runs recorded)\n"); db.close(); return; }
  for (const r of runs) {
    const res = `+${r.staged} -${r.dead} skip${r.skipped}`;
    console.log(`  ${r.started_at.replace("T", " ").slice(0, 19)}  ${r.status.padEnd(12)} ${res}  (${fmtDur(r.duration_ms)})${r.error ? `\n      ↳ ${r.error}` : ""}`);
  }
  console.log("");
  db.close();
}

// ── validate ────────────────────────────────────────────────────────────────
function cmdValidate(a) {
  console.log("Running validate-seeders.mjs (needs Supabase creds — PC only)...\n");
  const res = spawnSync(process.execPath, [join(SCRIPTS_DIR, "validate-seeders.mjs"), ...a], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

// ── emit-timer ──────────────────────────────────────────────────────────────
function cmdEmitTimer(a) {
  const dryRun = has(a, "--dry-run");
  const idx = buildIndex();
  const { onCalendar, fastestCadence } = emitTimer(idx);
  if (dryRun) {
    console.log(`\nFastest enabled cadence: ${fastestCadence} → OnCalendar=${onCalendar}\n`);
    console.log(emitTimer(idx).unit);
    return;
  }
  writeTimer(idx);
  console.log(`✓ Wrote .skyhook/skyhook-seed.timer — OnCalendar=${onCalendar} (fastest cadence: ${fastestCadence})`);
  console.log("  Apply on the Pi:");
  console.log("    sudo cp .skyhook/skyhook-seed.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart skyhook-seed.timer\n");
}

// ── stats ───────────────────────────────────────────────────────────────────
function cmdStats(a) {
  const source = val(a, "--source", null);
  const s = statsFromStaged({ source });
  console.log(`\n📊 Staged URLs: ${s.total}  ·  seeders: ${s.seeders}\n`);
  if (!s.total) { console.log("  (no staged results yet)\n"); return; }
  const bar = (n, max) => "█".repeat(Math.max(1, Math.round((n / max) * 24)));
  const maxSrc = Math.max(...s.bySource.map((r) => r.count), 1);
  console.log("  By seeder (top 20):");
  for (const r of s.bySource.slice(0, 20)) console.log(`    ${r.key.padEnd(28)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%  ${bar(r.count, maxSrc)}`);
  console.log("  By category:");
  for (const r of s.byCategory) console.log(`    ${r.label.padEnd(28)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%`);
  console.log("  By subcategory (top 20):");
  for (const r of s.bySubcategory.slice(0, 20)) console.log(`    ${r.label.padEnd(28)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%`);
  if (s.byLanguage.length) {
    console.log("  By language:");
    for (const r of s.byLanguage.slice(0, 10)) console.log(`    ${r.label.padEnd(28)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%`);
  }
  console.log("");
}

// ── cache ───────────────────────────────────────────────────────────────────
function cmdCache(a) {
  const sub = a.find((x) => !x.startsWith("--"));
  if (!sub || sub === "list") {
    const c = listCache();
    const stagedRows = c.staged.reduce((n, f) => n + f.count, 0);
    console.log(`\n🗂 Staged (${c.staged.length} sources, ${stagedRows} rows):`);
    for (const f of c.staged.slice(0, 40)) console.log(`    ${f.source.padEnd(28)} ${String(f.count).padStart(6)} rows  ${(f.bytes / 1024).toFixed(1)} KB`);
    console.log(`\n🗂 Discovery cache (${c.discovery.length} files):`);
    for (const d of c.discovery.slice(0, 40)) console.log(`    ${d.source.padEnd(28)} ${(d.bytes / 1024).toFixed(1)} KB`);
    console.log("");
    return;
  }
  if (sub === "prune") {
    const hard = has(a, "--hard");
    const filter = {
      source: val(a, "--source", null),
      category: val(a, "--category", null),
      subcategory: val(a, "--subcategory", null),
      before: val(a, "--before", null),
      after: val(a, "--after", null),
      url: val(a, "--url", null),
      language: val(a, "--language", null),
    };
    const r = pruneStaged(filter, { soft: !hard });
    console.log(`\n✂ Deleted ${r.deleted} staged URL(s) (kept ${r.kept})${r.archived ? `\n  archived → ${r.archived}` : ""}\n`);
    return;
  }
  if (sub === "clear") {
    const source = a.find((x) => x !== "clear" && !x.startsWith("--"));
    if (!source) { console.error("Usage: skyhook cache clear <source> [--discovery] [--hard]"); process.exitCode = 1; return; }
    if (has(a, "--discovery")) {
      const r = clearDiscovery(source);
      console.log(r.cleared ? `✓ Cleared discovery cache for "${source}"` : `(no discovery cache for "${source}")`);
    } else {
      const r = clearStaged(source, { soft: !has(a, "--hard") });
      console.log(`✂ Deleted ${r.deleted} staged URL(s) for "${source}"`);
    }
    console.log("");
    return;
  }
  console.error("Usage: skyhook cache [list | prune ... | clear <source> ...]");
  process.exitCode = 1;
}

// ── sync ────────────────────────────────────────────────────────────────────
async function cmdSync(a) {
  const sub = a.find((x) => !x.startsWith("--"));
  if (sub === "peers") {
    const peers = getPeers();
    console.log(`\nConfigured peers (node id: ${nodeId()}):`);
    if (!peers.length) console.log("  (none — add remote.peers in skyhook.config.json)");
    for (const p of peers) console.log(`    ${p.id} → ${p.url}`);
    console.log("");
    return;
  }
  if (sub === "pull") {
    const peerId = a.find((x) => x !== "pull" && !x.startsWith("--"));
    if (!peerId) { console.error("Usage: skyhook sync pull <peer-id>"); process.exitCode = 1; return; }
    const peer = peerFor(peerId);
    if (!peer) { console.error(`✗ No peer configured for "${peerId}"`); process.exitCode = 1; return; }
    const data = await pullStaged(peer);
    const rows = Array.isArray(data.rows) ? data.rows : (Array.isArray(data) ? data : []);
    const r = mergeRemoteRows(rows);
    console.log(`\n⇄ Merged ${rows.length} remote row(s) from "${peerId}": ${r.total} total (${r.added} new), ${r.sources} sources\n`);
    return;
  }
  console.error("Usage: skyhook sync [peers | pull <peer-id>]");
  process.exitCode = 1;
}

// ── push ────────────────────────────────────────────────────────────────────
async function cmdPush() {
  const r = await pushStagedToStorage();
  console.log(`\n⬆ Pushed staged → storage: ${r.pushed} inserted, ${r.skipped} skipped (of ${r.total})\n`);
}

// ── settings ────────────────────────────────────────────────────────────────
function cmdSettings(a) {
  if (a[0] === "allow-remote") {
    const on = a[1] === "on" || a[1] === "true" || a[1] === "1";
    saveSettings({ allowRemote: on });
    console.log(`\n✓ allowRemote = ${on ? "ON (worker)" : "OFF (standalone)"}\n`);
    return;
  }
  const v = settingsView();
  console.log(`\n🛰 Skyhook node settings`);
  console.log(`  node id      ${v.node.id}`);
  console.log(`  allowRemote  ${v.node.allowRemote ? "ON (worker — accepts remote control)" : "OFF (standalone)"}`);
  console.log(`  token        ${v.remote.hasToken ? "set" : "(none — open API)"}`);
  console.log(`  peers        ${v.remote.peers.length ? v.remote.peers.map((p) => `${p.id}→${p.url}`).join(", ") : "(none)"}`);
  console.log(`\n  Toggle: skyhook settings allow-remote on|off\n`);
}

// ── tui ─────────────────────────────────────────────────────────────────────
async function cmdTui() {
  try {
    const { runTui } = await import("./lib/tui.mjs");
    await runTui();
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      console.error("The interactive UI needs @inquirer/prompts. Run: npm install @inquirer/prompts");
    } else {
      console.error("TUI error:", err.message);
    }
    process.exitCode = 1;
  }
}

// ── serve ───────────────────────────────────────────────────────────────────
async function cmdServe(a) {
  const port = parseInt(val(a, "--port", "4173"), 10) || 4173;
  const { startServer } = await import("./lib/api-server.mjs");
  startServer(port); // blocks until Ctrl+C
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || has(argv, "--help") || has(argv, "-h")) { usage(); return; }
  const cmd = argv[0];
  const args = argv.slice(1);
  switch (cmd) {
    case "help": args[0] ? helpFor(args[0]) : usage(); break;
    case "list": case "status": cmdList(args); break;
    case "due": cmdDue(args); break;
    case "run": await cmdRun(args); break;
    case "run-due": await cmdRunDue(args); break;
    case "schedule": cmdSchedule(args); break;
    case "enable": cmdEnable(args); break;
    case "disable": cmdDisable(args); break;
    case "history": cmdHistory(args); break;
    case "validate": cmdValidate(args); break;
    case "emit-timer": cmdEmitTimer(args); break;
    case "stats": cmdStats(args); break;
    case "cache": cmdCache(args); break;
    case "sync": await cmdSync(args); break;
    case "push": await cmdPush(args); break;
    case "settings": cmdSettings(args); break;
    case "tui": await cmdTui(); break;
    case "serve": await cmdServe(args); break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main();

