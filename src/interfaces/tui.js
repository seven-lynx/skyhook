/**
 * tui.mjs — interactive control center (terminal UI) for skyhook.
 *
 * Driven by @inquirer/prompts (fuzzy-searchable selects), so 606 seeders are
 * easy to navigate. All logic lives in seeder-engine.mjs — this module is a
 * thin interactive front-end. Launched via `node skyhook.mjs tui`.
 */
import { select, checkbox, confirm, input, Separator } from "@inquirer/prompts";
import { spawn, spawnSync } from "child_process";
import {
  buildIndex, openState, getState, listRuns, runPool, editManifest,
  emitTimer, writeTimer, resolveSeeder, CADENCES, ROOT, LOGS_DIR, SCRIPTS_DIR,
} from "../engine/seeder-engine.js";
import { settingsView, saveSettings } from "../core/settings.js";
import { statsFromStaged } from "../core/analytics.js";

const tierOf = (s) => (s.isNews ? "news" : "evergreen");

function fmtAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtResult(json) {
  if (!json) return "";
  try {
    const r = JSON.parse(json);
    return `+${r.staged ?? 0} -${r.dead ?? 0}`;
  } catch { return ""; }
}

async function pickSeeders(message, { max = 300 } = {}) {
  const idx = buildIndex();
  const q = await input({ message: "Filter (source/name/category — Enter for all):" });
  const f = q.trim().toLowerCase();
  let subset = idx;
  if (f) {
    subset = idx.filter((s) =>
      s.source.toLowerCase().includes(f) ||
      s.script.includes(f) ||
      (s.displayName || "").toLowerCase().includes(f) ||
      (s.category || "").toLowerCase().includes(f));
  }
  subset = [...subset].sort((a, b) => (Number(b.scheduled) - Number(a.scheduled)) || a.source.localeCompare(b.source));
  if (!subset.length) { console.log("  No matches."); return []; }
  if (subset.length > max) {
    console.log(`  ${subset.length} matches — showing first ${max} (narrow the filter for the rest).`);
    subset = subset.slice(0, max);
  }
  const db = openState();
  const choices = subset.map((s) => {
    const st = getState(db, s.source);
    const label = `${s.source.padEnd(20)} ${s.cadence.padEnd(8)} ${tierOf(s).padEnd(9)} last:${st?.last_run_at ? fmtAgo(st.last_run_at) : "never"}`;
    return { name: label, value: s.source };
  });
  const picked = await checkbox({ message: `${message} (space=select, enter=done):`, choices, pageSize: 14 });
  db.close();
  return picked.map((src) => resolveSeeder(src, idx)).filter(Boolean);
}

async function pickOne(message) {
  const picked = await pickSeeders(message, { max: 300 });
  return picked.length ? picked[0] : null;
}

// ── screens ─────────────────────────────────────────────────────────────────

function showDashboard() {
  const idx = buildIndex();
  const db = openState();
  const scheduled = idx.filter((s) => s.scheduled);
  const msOf = { hourly: 3600e3, "6h": 6 * 3600e3, "12h": 12 * 3600e3, daily: 86400e3, weekly: 7 * 86400e3, monthly: 30 * 86400e3, manual: Infinity };
  const due = scheduled.filter((s) => {
    const st = getState(db, s.source);
    if (!st?.last_run_at) return true;
    const ms = msOf[s.cadence] ?? 7 * 86400e3;
    if (!isFinite(ms)) return false;
    return Date.now() - new Date(st.last_run_at).getTime() >= ms;
  });
  const errors = scheduled.filter((s) => {
    const st = getState(db, s.source);
    return st && st.last_status && st.last_status !== "ok";
  });

  console.log(`\n  Seeders: ${idx.length} total  ·  ${scheduled.length} scheduled  ·  ${due.length} due  ·  ${errors.length} errors\n`);
  if (!scheduled.length) { console.log("  (nothing scheduled — use 'Schedule editor' or 'enable')\n"); db.close(); return; }

  const rows = scheduled.map((s) => {
    const st = getState(db, s.source);
    return {
      source: s.source, cadence: s.cadence, tier: tierOf(s),
      last: st?.last_run_at ? fmtAgo(st.last_run_at) : "never",
      res: st ? fmtResult(st.last_result) : "",
      flag: st && st.last_status && st.last_status !== "ok" ? " ❌" : "",
    };
  });
  const w = (k, min) => Math.max(min, ...rows.map((r) => r[k].length));
  const W = { source: w("source", 8), cadence: w("cadence", 8), tier: w("tier", 9), last: w("last", 8), res: w("res", 8) };
  console.log(`  ${"SOURCE".padEnd(W.source)} ${"CADENCE".padEnd(W.cadence)} ${"TIER".padEnd(W.tier)} ${"LAST".padEnd(W.last)} ${"RESULT".padEnd(W.res)}`);
  console.log("  " + "─".repeat(W.source + W.cadence + W.tier + W.last + W.res + 4));
  for (const r of rows) {
    console.log(`  ${r.source.padEnd(W.source)} ${r.cadence.padEnd(W.cadence)} ${r.tier.padEnd(W.tier)} ${(r.last + r.flag).padEnd(W.last)} ${r.res.padEnd(W.res)}`);
  }
  console.log("");
  db.close();
}

async function screenRun() {
  const seeders = await pickSeeders("Run seeders");
  if (!seeders.length) return;
  const par = await input({ message: "Concurrency (1–8):", default: "2", validate: (v) => (/^[1-8]$/.test(v) ? true : "1–8") });
  const withHeadless = await confirm({ message: "Allow headless browser?", default: false });
  const aggressive = await confirm({ message: "Aggressive (force all tiers)?", default: false });
  const forceHeadless = await confirm({ message: "Force headless crawl (even after short-circuit)?", default: false });
  const noCache = await confirm({ message: "Ignore cache (re-fetch)?", default: false });
  console.log(`\n▶ Running ${seeders.length} seeder(s), concurrency=${par}...\n`);
  const results = await runPool(seeders, { concurrency: parseInt(par, 10) || 2, withHeadless, aggressive, forceHeadless, noCache });
  const failed = results.filter((r) => r.status !== "ok");
  console.log(`\n🏁 ${results.length - failed.length} ok, ${failed.length} failed.`);
  for (const r of results) {
    const res = r.result ? ` +${r.result.staged} -${r.result.dead}` : "";
    console.log(`  ${r.status === "ok" ? "✓" : "✗"} ${r.seeder.source}  ${r.status}${res}`);
  }
  await input({ message: "\nPress Enter to continue" });
}

function tmuxAvailable() { return spawnSync("tmux", ["-V"]).status === 0; }

function tmuxLaunch(seeder) {
  const cmd = `cd ${ROOT} && SKYHOOK_STAGE_ONLY=1${seeder.skipHeadless ? " SKYHOOK_SKIP_HEADLESS=1" : ""} node ${SCRIPTS_DIR}/${seeder.script} --stage-only${seeder.maxAgeDays != null ? ` --max-age-days ${seeder.maxAgeDays}` : ""}`;
  const hasSession = spawnSync("tmux", ["has-session", "-t", "skyhook"]).status === 0;
  const args = hasSession
    ? ["new-window", "-t", "skyhook", "-n", seeder.source, cmd]
    : ["new-session", "-d", "-s", "skyhook", "-n", seeder.source, cmd];
  return spawnSync("tmux", args, { stdio: "ignore" }).status === 0;
}

async function screenParallel() {
  if (!tmuxAvailable()) {
    console.log("\n  tmux is not installed — use 'Run seeders' instead.\n  (Install: sudo apt-get install -y tmux)\n");
    await input({ message: "Press Enter to continue" });
    return;
  }
  const seeders = await pickSeeders("Run in parallel (one tmux window each)");
  if (!seeders.length) return;
  let ok = 0;
  for (const s of seeders) {
    if (tmuxLaunch(s)) { console.log(`  ✓ ${s.source} → tmux window`); ok++; }
    else console.log(`  ✗ ${s.source} failed to launch`);
  }
  console.log(`\n${ok}/${seeders.length} launched. Attach with: tmux attach -t skyhook`);
  await input({ message: "\nPress Enter to continue" });
}

async function screenSchedule() {
  const seeder = await pickOne("Edit schedule for");
  if (!seeder) return;
  const db = openState();
  const st = getState(db, seeder.source);
  db.close();
  console.log(`\n  ${seeder.source} — currently cadence=${seeder.cadence}, tier=${tierOf(seeder)}, maxAgeDays=${seeder.maxAgeDays ?? "—"} (last run ${st?.last_run_at ? fmtAgo(st.last_run_at) : "never"})\n`);

  const cadence = await select({
    message: "Cadence:",
    choices: CADENCES.map((c) => ({ name: c, value: c })),
  });
  const isNews = await select({
    message: "Tier:",
    choices: [
      { name: "evergreen", value: false },
      { name: "news (age-pruned)", value: true },
    ],
  });
  const age = await input({ message: "max-age-days (blank/0 = none):", default: seeder.maxAgeDays ? String(seeder.maxAgeDays) : "0" });
  const maxAgeDays = age === "" || age === "0" ? null : Number(age);

  const entry = editManifest({ query: seeder.source, cadence, isNews, maxAgeDays });
  if (entry) {
    console.log(`\n✓ ${entry.source}: cadence=${entry.cadence} tier=${entry.isNews ? "news" : "evergreen"} maxAgeDays=${entry.maxAgeDays ?? "—"}`);
    console.log("  Reminder: 'Emit timer' (from the menu) to refresh the systemd timer.");
  } else {
    console.log("\n✗ Failed to update schedule.");
  }
  await input({ message: "\nPress Enter to continue" });
}

async function screenHistory() {
  const seeder = await pickOne("History for");
  if (!seeder) return;
  const db = openState();
  const runs = listRuns(db, seeder.source, 15);
  console.log(`\n  ${seeder.source} — last ${runs.length} run(s)\n`);
  if (!runs.length) console.log("  (no runs recorded)");
  for (const r of runs) {
    console.log(`  ${r.started_at.replace("T", " ").slice(0, 19)}  ${r.status.padEnd(12)} +${r.staged} -${r.dead} skip${r.skipped}  ${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + "s" : ""}${r.error ? `\n      ↳ ${r.error}` : ""}`);
  }
  console.log("");
  db.close();
  await input({ message: "Press Enter to continue" });
}

async function screenEmitTimer() {
  const { onCalendar, fastestCadence } = emitTimer(buildIndex());
  const write = await confirm({ message: `Regenerate systemd timer → OnCalendar=${onCalendar} (fastest: ${fastestCadence})?`, default: true });
  if (!write) return;
  writeTimer(buildIndex());
  console.log(`\n✓ Wrote .skyhook/skyhook-seed.timer (OnCalendar=${onCalendar}).`);
  console.log("  Apply: sudo cp .skyhook/skyhook-seed.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart skyhook-seed.timer");
  await input({ message: "\nPress Enter to continue" });
}

async function screenStats() {
  const s = statsFromStaged();
  console.log(`\n  📊 Staged URLs: ${s.total}  ·  seeders: ${s.seeders}\n`);
  if (!s.total) {
    console.log("  (no staged results yet)");
  } else {
    console.log("  By category:");
    for (const r of s.byCategory) console.log(`    ${r.label.padEnd(26)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%`);
    console.log("  Top seeders:");
    for (const r of s.bySource.slice(0, 12)) console.log(`    ${r.key.padEnd(26)} ${String(r.count).padStart(6)}  ${r.pct.toFixed(1).padStart(5)}%`);
  }
  console.log("");
  await input({ message: "Press Enter to continue" });
}

async function screenSettings() {
  const v = settingsView();
  console.log(`\n  🛰 Settings\n`);
  console.log(`  node id      ${v.node.id}`);
  console.log(`  allowRemote  ${v.node.allowRemote ? "ON (worker)" : "OFF (standalone)"}`);
  console.log(`  token        ${v.remote.hasToken ? "set" : "(none — open API)"}`);
  console.log(`  peers        ${v.remote.peers.length ? v.remote.peers.map((p) => `${p.id}→${p.url}`).join(", ") : "(none)"}\n`);
  const toggle = await confirm({ message: `allowRemote is ${v.node.allowRemote ? "ON" : "OFF"} — toggle it?`, default: false });
  if (toggle) {
    saveSettings({ allowRemote: !v.node.allowRemote });
    console.log(`\n  ✓ allowRemote = ${!v.node.allowRemote ? "ON (worker)" : "OFF (standalone)"}`);
  }
  await input({ message: "\nPress Enter to continue" });
}

// ── main loop ───────────────────────────────────────────────────────────────

export async function runTui() {
  console.log("\n  🛰  Skyhook Control Center\n");
  while (true) {
    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "📊  Dashboard", value: "dash" },
        { name: "▶️   Run seeders", value: "run" },
        { name: "🔀  Run in parallel (tmux)", value: "par" },
        { name: "📅  Schedule editor", value: "sched" },
        { name: "📜  History", value: "hist" },
        { name: "📊  Stats", value: "stats" },
        { name: "⚙️   Settings", value: "settings" },
        { name: "⏰  Emit timer", value: "timer" },
        new Separator(),
        { name: "🚪  Quit", value: "quit" },
      ],
      pageSize: 9,
    });
    switch (action) {
      case "dash": showDashboard(); break;
      case "run": await screenRun(); break;
      case "par": await screenParallel(); break;
      case "sched": await screenSchedule(); break;
      case "hist": await screenHistory(); break;
      case "stats": await screenStats(); break;
      case "settings": await screenSettings(); break;
      case "timer": await screenEmitTimer(); break;
      case "quit": console.log(""); return;
    }
  }
}

