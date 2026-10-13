"use strict";

/* Skyhook Control — browser GUI over the skyhook HTTP API.
 * Zero dependencies; served from src/gui/ by interfaces/api-server.js. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

const CADENCES = ["hourly", "6h", "12h", "daily", "weekly", "monthly", "manual"];
const CADENCE_MS = {
  hourly: 3600e3, "6h": 6 * 3600e3, "12h": 12 * 3600e3,
  daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3, monthly: 30 * 24 * 3600e3,
  manual: Infinity,
};
const CADENCE_TIP = {
  hourly: "Every hour — for very fast-moving sources.",
  "6h": "Every 6 hours — only if a source genuinely needs it.",
  "12h": "Twice a day — the default for fast news.",
  daily: "Once a day.",
  weekly: "Once a week — the default cadence.",
  monthly: "Once a month — slow, archival sources.",
  manual: "Never auto-run — run on demand only.",
};

const state = {
  seeders: [],
  running: [],
  batch: null,
  pipe: null,
  sortKey: "source",
  sortDir: 1,
  selected: new Set(),
  apiBase: localStorage.getItem("skyhook.apiBase") || "",
  live: null,
  logTimer: null,
  logSources: [],
  followLog: true,
  logTab: null,
  historySource: null,
  wasRunning: false,
  categories: [],
  infoSource: null,
  taggingGaps: null,
};

// ── API ─────────────────────────────────────────────────────────────────────
const apiBase = () => {
  if (state.apiBase.trim()) return state.apiBase.trim().replace(/\/+$/, "");
  if (window.location.protocol === "file:") return "http://localhost:4173";
  return window.location.origin;
};

async function api(method, path, body) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const get = (p) => api("GET", p);
const post = (p, b) => api("POST", p, b || {});

// ── formatting ──────────────────────────────────────────────────────────────
function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtIn(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "due";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

const fmtDur = (ms) => (ms == null ? "" : `${(ms / 1000).toFixed(1)}s`);
const fmtElapsed = (ms) => {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};
const resultText = (r) => (r ? `+${r.staged ?? 0} −${r.dead ?? 0}` : "");

const fmtEta = (ms) => {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

function isDueClient(s) {
  if (!s.scheduled || s.cadence === "manual") return false;
  if (!s.lastRunAt) return true;
  const ms = CADENCE_MS[s.cadence] ?? CADENCE_MS.weekly;
  if (!isFinite(ms)) return false;
  return Date.now() - new Date(s.lastRunAt).getTime() >= ms;
}

// ── toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ── tabs ────────────────────────────────────────────────────────────────────
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === name));
  if (name === "stats") renderAnalytics();
  else if (name === "curation") renderCuration();
  else if (name === "settings") renderSettings();
}

// ── seeders table ───────────────────────────────────────────────────────────
function filtered() {
  const f = $("#filter").value.trim().toLowerCase();
  const tier = $("#tierFilter").value;
  const sched = $("#schedFilter").value;
  const status = $("#statusFilter").value;
  let rows = state.seeders;
  if (f) {
    rows = rows.filter((s) =>
      (s.source || "").toLowerCase().includes(f) ||
      (s.script || "").toLowerCase().includes(f) ||
      (s.displayName || "").toLowerCase().includes(f) ||
      (s.categoryLabel || "").toLowerCase().includes(f) ||
      (s.subcategoryLabel || "").toLowerCase().includes(f));
  }
  if (tier === "news") rows = rows.filter((s) => s.isNews);
  if (tier === "evergreen") rows = rows.filter((s) => !s.isNews);
  if (sched === "1") rows = rows.filter((s) => s.scheduled);
  if (sched === "0") rows = rows.filter((s) => !s.scheduled);
  if (status === "due") rows = rows.filter(isDueClient);
  if (status === "errors") rows = rows.filter((s) => s.lastStatus && s.lastStatus !== "ok");

  const k = state.sortKey;
  return [...rows].sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === "number" ? av - bv
      : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return cmp * state.sortDir;
  });
}

function renderSeeders() {
  const rows = filtered();
  $("#countLabel").textContent = `${rows.length} / ${state.seeders.length}`;
  const tbody = $("#seederBody");
  tbody.innerHTML = "";
  const runningSet = new Set(state.running.map((r) => r.source));
  for (const s of rows) {
    const tr = document.createElement("tr");
    const statusCls = s.lastStatus === "ok" ? "ok" : s.lastStatus ? "err" : "";
    const result = resultText(s.lastResult);
    const isRunning = runningSet.has(s.source);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" data-source="${esc(s.source)}" ${state.selected.has(s.source) ? "checked" : ""}></td>
      <td class="src" title="${esc(s.script)}">${esc(s.source)}${isRunning ? ' <span class="spin">●</span>' : ""}</td>
      <td class="name muted"${s.description ? ` data-tip="${esc(s.description)}"` : ""}>${esc(s.displayName || "")}</td>
      <td class="muted">${esc(s.categoryLabel || "")}${s.subcategoryLabel ? " · " + esc(s.subcategoryLabel) : ""}</td>
      <td><span class="cadence ${s.scheduled ? "" : "manual"}" data-tip="${esc(CADENCE_TIP[s.cadence] || "")}">${esc(s.cadence)}</span></td>
      <td><span class="tier ${s.isNews ? "news" : "evergreen"}" data-tip="${s.isNews ? "News — age-pruned by max-age." : "Evergreen — kept indefinitely."}">${s.isNews ? "news" : "evergreen"}</span></td>
      <td>${fmtAgo(s.lastRunAt)}</td>
      <td class="result ${statusCls}">${result || (s.lastError ? esc(s.lastError) : s.lastStatus ? esc(s.lastStatus) : "—")}</td>
      <td>${fmtIn(s.nextRunAt)}</td>
      <td class="col-actions">
        <button class="mini" data-action="run" data-source="${esc(s.source)}" title="Run now">▶</button>
        <button class="mini" data-action="schedule" data-source="${esc(s.source)}" title="Edit schedule">⚙</button>
        <button class="mini" data-action="toggle" data-source="${esc(s.source)}" title="${s.scheduled ? "Disable (remove from schedule)" : "Enable (add to schedule)"}">${s.scheduled ? "⏻" : "+"}</button>
        <button class="mini" data-action="info" data-source="${esc(s.source)}" title="View all metadata">ℹ</button>
        <button class="mini" data-action="history" data-source="${esc(s.source)}" title="Run history">🗒</button>
      </td>`;
    tbody.appendChild(tr);
  }
  $("#checkAll").checked = rows.length > 0 && rows.every((s) => state.selected.has(s.source));
  $("#runSelectedBtn").disabled = state.selected.size === 0;
}

// ── data loading / rendering ────────────────────────────────────────────────
async function loadSeeders() {
  state.seeders = await get("/api/seeders?limit=5000");
}

async function loadRunning() {
  const r = await get("/api/running").catch(() => ({}));
  state.running = Array.isArray(r) ? r : (r.running || []);
  state.batch = Array.isArray(r) ? null : (r.batch || null);
}

async function loadPipeline() {
  state.pipe = await get("/api/pipeline").catch(() => null);
}

function renderStats() {
  const total = state.seeders.length;
  const scheduled = state.seeders.filter((s) => s.scheduled).length;
  const due = state.seeders.filter(isDueClient).length;
  const errors = state.seeders.filter((s) => s.lastStatus && s.lastStatus !== "ok").length;
  $("#stats").innerHTML = `
    <div class="stat" data-goto="seeders" data-tip="Click to view all seeders.">
      <span class="stat-num">${total}</span><span class="stat-label">seeders</span>
    </div>
    <div class="stat" data-goto="scheduled" data-tip="Click to view scheduled seeders and their cadence / tier / max-age.">
      <span class="stat-num">${scheduled}</span><span class="stat-label">scheduled</span>
    </div>
    <div class="stat ${due ? "warn" : ""}" data-goto="due" data-tip="Click to view seeders due to run now.">
      <span class="stat-num">${due}</span><span class="stat-label">due now</span>
    </div>
    <div class="stat ${errors ? "bad" : ""}" data-goto="errors" data-tip="Click to view an organized list of seeders whose last run failed.">
      <span class="stat-num">${errors}</span><span class="stat-label">errors</span>
    </div>`;
}

function renderRunning() {
  const el = $("#runningList");
  if (!state.running.length) {
    el.innerHTML = '<p class="muted">Nothing running.</p>';
    return;
  }
  el.innerHTML = state.running.map((r) => `
    <div class="due-row">
      <span class="spin">●</span>
      <strong>${esc(r.source)}</strong>
      <span class="muted">${fmtElapsed(r.elapsedMs)}</span>
      <button class="mini" data-action="stop-one" data-source="${esc(r.source)}" title="Stop this seeder">⏹</button>
    </div>`).join("");
}

function renderFailures() {
  const el = $("#failList");
  const fails = state.seeders.filter((s) => s.lastStatus && s.lastStatus !== "ok")
    .sort((a, b) => (b.lastRunAt || "").localeCompare(a.lastRunAt || ""));
  if (!fails.length) {
    el.innerHTML = '<p class="muted">No failures. 🎉</p>';
    return;
  }
  el.innerHTML = fails.slice(0, 30).map((s) => `
    <div class="fail-row">
      <strong>${esc(s.source)}</strong>
      <span class="badge err">${esc(s.lastStatus || "error")}</span>
      <span class="muted">${esc(s.lastError || "")}</span>
      <span class="muted">${fmtAgo(s.lastRunAt)}</span>
      <button class="mini" data-action="run" data-source="${esc(s.source)}" title="Retry now">▶</button>
    </div>`).join("");
}

async function renderDashboard() {
  renderStats();
  renderRunning();
  renderFailures();
  const due = state.seeders.filter(isDueClient);
  const list = $("#dueList");
  if (!due.length) {
    list.innerHTML = '<p class="muted">Nothing due right now.</p>';
    return;
  }
  list.innerHTML = due.slice(0, 60).map((s) => `
    <div class="due-row">
      <strong title="${esc(s.script)}">${esc(s.source)}</strong>
      <span class="muted">${esc(s.cadence)}</span>
      <span class="muted">last ${fmtAgo(s.lastRunAt)}</span>
      <button class="mini" data-action="run" data-source="${esc(s.source)}">▶</button>
    </div>`).join("");
}

function fmtAge(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderPipeline() {
  const p = state.pipe;
  if (!p) return;

  const cards = Array.isArray(p.cards) ? p.cards : [];
  $("#pipelineCards").innerHTML = cards.map((c) => `
    <div class="pipe-card">
      <div class="pipe-num">${esc(c.value ?? "—")}</div>
      <div class="pipe-label">${esc(c.label)}</div>
      ${c.sub ? `<div class="pipe-sub">${esc(c.sub)}</div>` : ""}
      ${(c.actions || []).map((a) => `<button class="btn ${a.danger ? "danger" : "primary"}" data-pipe="${esc(a.id)}" ${a.danger ? 'data-danger="1"' : ""} title="${esc(a.label)}">${esc(a.label)}</button>`).join("")}
    </div>`).join("");

  const checks = Array.isArray(p.checks) ? p.checks : [];
  $("#pipelineChecks").innerHTML = checks.map((c) =>
    `<span class="prereq ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.label)}</span>`).join("");

  const jobs = Array.isArray(p.jobs) ? p.jobs : [];
  $("#pipelineJobs").innerHTML = jobs.length
    ? jobs.map((j) =>
        `<div class="job-row"><span class="job-status ${esc(j.status || "")}"></span><span>${esc(j.label)}</span><span class="job-state">${esc(j.status || "")}</span></div>`).join("")
    : "";

  $("#pipelineNote").textContent = p.note || "";
  renderPipelineGaps();
  renderTaggingTasks();
}

const GAP_LABELS = {
  category: "Missing categories",
  subcategory: "Missing subcategories",
  tags: "Untagged URLs",
  contentType: "Missing content types",
  quality: "Missing quality",
  attributes: "Missing attributes",
};

function gapCards(missing, total) {
  if (!missing) return '<p class="muted">No offline DB available.</p>';
  const order = ["category", "subcategory", "tags", "contentType", "quality", "attributes"];
  return order.map((k) => {
    const n = missing[k] ?? 0;
    return `<div class="stat"><span class="stat-num">${Number(n).toLocaleString()}</span><span class="stat-label">${GAP_LABELS[k]}</span></div>`;
  }).join("");
}

async function loadTaggingGaps() {
  const g = await get("/api/tagging/missing").catch(() => null);
  state.taggingGaps = g;
  return g;
}

async function renderPipelineGaps() {
  let g = state.taggingGaps;
  if (!g) g = await loadTaggingGaps();
  if (!g) { $("#taggingGaps").innerHTML = ""; return; }
  $("#taggingGaps").innerHTML = gapCards(g.missing, g.total);
}

async function renderStatsGaps() {
  const g = await loadTaggingGaps();
  if (!g) { $("#statsGaps").innerHTML = '<p class="muted">Unavailable.</p>'; return; }
  $("#statsGaps").innerHTML = gapCards(g.missing, g.total);
}

async function renderTaggingTasks() {
  try {
    await loadTaggingGaps();
    const g = state.taggingGaps;
    const missing = g?.missing || {};
    const tasks = [
      { key: "fill-category", label: "Fill missing categories", count: missing.category },
      { key: "fill-subcategory", label: "Fill missing subcategories", count: missing.subcategory },
      { key: "fill-tags", label: "Add tags to untagged URLs", count: missing.tags },
      { key: "fill-content-type", label: "Fill missing content types", count: missing.contentType },
      { key: "fill-quality", label: "Fill missing quality", count: missing.quality },
      { key: "fill-attributes", label: "Fill missing attributes", count: missing.attributes },
    ];
    const sel = $("#tagTask");
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select a task…</option>' + tasks.map((t) =>
      `<option value="${esc(t.key)}">${esc(t.label)}${t.count != null ? ` (${Number(t.count).toLocaleString()})` : ""}</option>`).join("");
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    $("#runTaskBtn").disabled = false;
  } catch (err) {
    $("#tagTask").innerHTML = '<option value="">Unavailable</option>';
    $("#runTaskBtn").disabled = true;
  }
}

async function runTask() {
  const task = $("#tagTask").value;
  if (!task) { toast("Select a task first.", "err"); return; }
  try {
    const res = await post("/api/tagging/run", { task });
    toast(`Started ${res.task}.`);
    // Open the live-log drawer to monitor progress.
    const sources = state.running.length ? state.running.map((r) => r.source) : [];
    openLogDrawer([...new Set([...sources, res.job])]);
    startLogPolling();
    await loadRunning();
    renderLogTabs();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function renderTimer() {
  const t = await get("/api/timer").catch(() => null);
  if (!t) { $("#timerOnCalendar").textContent = "unavailable"; return; }
  $("#timerOnCalendar").textContent = t.onCalendar || "—";
  $("#timerCadence").textContent = t.fastestCadence || "—";
  $("#timerUnit").textContent = t.unit || "";
}

function updateRunningUI() {
  const n = state.running.length;
  $("#runningBadge").textContent = n ? `${n} running` : "";
  $("#stopBtn").disabled = n === 0;
  renderProgress();
  renderRunningNow();
  updateShowLogBtn();
  if (!n) stopLogPolling();
}

function renderRunningNow() {
  const el = $("#runningNow");
  if (!el) return;
  if (!state.running.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = [...state.running]
    .sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))
    .map((r) => `<span class="now-item"><span class="spin">●</span> ${esc(r.source)} <span class="muted">${fmtElapsed(r.elapsedMs)}</span></span>`)
    .join('<span class="now-sep">·</span>');
  el.hidden = false;
}

function renderProgress() {
  const el = $("#runProgress");
  if (!el) return;
  const b = state.batch;
  if (!b || !b.total) { el.textContent = ""; return; }
  const eta = b.etaMs != null && b.etaMs > 0 ? ` · ~${fmtEta(b.etaMs)}` : "";
  const cached = ` · +${Number(b.stagedTotal ?? 0).toLocaleString()} cached`;
  el.textContent = `${b.remaining}/${b.total} remaining${eta}${cached}`;
}

// ── analytics / curation / settings tabs ───────────────────────────────────
function barRow(label, count, pct) {
  return `
    <div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, pct)}%"></span></span>
      <span class="bar-count">${count.toLocaleString()} · ${pct}%</span>
    </div>`;
}

async function renderAnalytics() {
  try {
    const s = await get("/api/stats");
    $("#analyticsCards").innerHTML = `
      <div class="stat"><span class="stat-num">${s.total.toLocaleString()}</span><span class="stat-label">staged URLs</span></div>
      <div class="stat"><span class="stat-num">${s.seeders.toLocaleString()}</span><span class="stat-label">seeders</span></div>`;
    const list = (title, arr, limit) =>
      (arr.length ? `<h3>${title}</h3>` + arr.slice(0, limit ?? arr.length).map((r) => barRow(r.label ?? r.key, r.count, r.pct)).join("") : "");
    $("#analyticsBody").innerHTML = s.total
      ? list("By seeder", s.bySource, 25) + list("By category", s.byCategory) + list("By subcategory", s.bySubcategory, 25) + list("By language", s.byLanguage)
      : '<p class="muted">No staged results yet.</p>';
    renderStatsGaps();
  } catch (err) {
    $("#analyticsBody").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function renderSettings() {
  try {
    const s = await get("/api/settings");
    const peers = s.remote.peers.length ? s.remote.peers.map((p) => `${esc(p.id)} → ${esc(p.url)}`).join("<br>") : "(none)";
    $("#settingsBody").innerHTML = `
      <div class="stats">
        <div class="stat"><span class="stat-num">${esc(s.node.id)}</span><span class="stat-label">node id</span></div>
        <div class="stat"><span class="stat-num">${s.node.allowRemote ? "ON" : "OFF"}</span><span class="stat-label">allow remote</span></div>
        <div class="stat"><span class="stat-num">${s.remote.hasToken ? "set" : "—"}</span><span class="stat-label">token</span></div>
      </div>
      <p>${s.node.allowRemote ? "This node is a <strong>worker</strong> — it accepts remote control from a master." : "This node is <strong>standalone</strong> — a normal seeder manager."}</p>
      <p class="muted">Peers: ${peers}</p>
      <p><button id="toggleRemoteBtn" class="btn ${s.node.allowRemote ? "danger" : "primary"}">${s.node.allowRemote ? "⏻ Turn off remote control" : "⏻ Turn on remote control (worker)"}</button></p>`;
    $("#toggleRemoteBtn").addEventListener("click", async () => {
      try {
        await post("/api/settings", { allowRemote: !s.node.allowRemote });
        toast(s.node.allowRemote ? "Remote control off." : "Remote control on (worker).");
        renderSettings();
      } catch (err) { toast(err.message, "err"); }
    });
  } catch (err) {
    $("#settingsBody").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function renderCuration() {
  try {
    const c = await get("/api/cache");
    const stagedRows = c.staged.reduce((n, f) => n + f.count, 0);
    const staged = c.staged.length
      ? `<h3>Staged (${c.staged.length} sources, ${stagedRows.toLocaleString()} rows)</h3>
        <div class="table-wrap"><table><thead><tr><th>Source</th><th>Rows</th><th>KB</th><th></th></tr></thead><tbody>
        ${c.staged.map((f) => `<tr><td>${esc(f.source)}</td><td>${f.count.toLocaleString()}</td><td>${(f.bytes / 1024).toFixed(1)}</td><td><button class="mini" data-action="clear-staged" data-source="${esc(f.source)}">clear</button></td></tr>`).join("")}
        </tbody></table></div>`
      : '<p class="muted">No staged results.</p>';
    const discovery = c.discovery.length
      ? `<h3>Discovery cache (${c.discovery.length} files)</h3>
        <div class="table-wrap"><table><thead><tr><th>Source</th><th>KB</th><th></th></tr></thead><tbody>
        ${c.discovery.map((d) => `<tr><td>${esc(d.source)}</td><td>${(d.bytes / 1024).toFixed(1)}</td><td><button class="mini" data-action="clear-discovery" data-source="${esc(d.source)}">clear</button></td></tr>`).join("")}
        </tbody></table></div>`
      : '<p class="muted">No discovery cache.</p>';
    $("#curationBody").innerHTML = staged + discovery;
  } catch (err) {
    $("#curationBody").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

async function refreshAll() {
  try {
    await loadSeeders();
    await loadRunning();
    await loadPipeline();
    renderSeeders();
    await renderDashboard();
    await renderTimer();
    renderPipeline();
    updateRunningUI();
    $("#apiLabel").textContent = `api → ${apiBase()}`;
    $("#apiLabel").classList.remove("offline");
  } catch (err) {
    $("#apiLabel").textContent = `offline — ${err.message}`;
    $("#apiLabel").classList.add("offline");
    toast("Cannot reach API: " + err.message, "err");
  }
}

// ── actions ─────────────────────────────────────────────────────────────────
function runConcurrency() {
  return Math.max(1, Number($("#concurrency").value) || 1);
}
function runWithHeadless() {
  return $("#withHeadless").checked;
}
function runAggressive() {
  return $("#aggressive").checked;
}
function runForceHeadless() {
  return $("#forceHeadless").checked;
}
function runNoCache() {
  return $("#noCache").checked;
}

async function runSources(sources) {
  if (!sources.length) return;
  const concurrency = runConcurrency();
  try {
    const res = await post("/api/run", {
      sources,
      parallel: concurrency,
      withHeadless: runWithHeadless(),
      aggressive: runAggressive(),
      forceHeadless: runForceHeadless(),
      noCache: runNoCache(),
    });
    toast(`Started ${res.started.length} seeder(s) — parallel=${concurrency}.`);
  } catch (err) {
    toast("Run failed: " + err.message, "err");
    return;
  }
  await loadRunning();
  openLogDrawer(sources);
  renderRunning();
  startLogPolling();
  updateRunningUI();
}

async function stopRuns(source) {
  try {
    const res = await post("/api/stop", source ? { source } : {});
    toast(source ? `Stopped ${source}.` : `Stopped ${res.stopped.length} run(s).`);
  } catch (err) {
    toast("Stop failed: " + err.message, "err");
  }
  await refreshAll();
}

async function bulkEnable() {
  const srcs = [...state.selected];
  if (!srcs.length) { toast("Nothing selected."); return; }
  for (const source of srcs) {
    try { await post("/api/enable", { source, cadence: "weekly" }); } catch {}
  }
  toast(`Enabled ${srcs.length} seeder(s) (weekly).`);
  await refreshAll();
}

async function bulkDisable() {
  const srcs = [...state.selected];
  if (!srcs.length) { toast("Nothing selected."); return; }
  for (const source of srcs) {
    try { await post("/api/disable", { source }); } catch {}
  }
  toast(`Disabled ${srcs.length} seeder(s).`);
  await refreshAll();
}

// ── live log drawer ─────────────────────────────────────────────────────────
function openLogDrawer(sources) {
  // Merge the just-started sources with everything currently running so the
  // tabs always include both seeders and pipeline jobs (e.g. the tagger).
  const all = [...new Set([...sources, ...state.running.map((r) => r.source)])];
  state.logSources = all;
  state.followLog = true;
  const runningSet = new Set(state.running.map((r) => r.source));
  // Auto-select first running source; fall back to combined "All" view.
  state.logTab = all.find((s) => runningSet.has(s)) || "__all__";
  $("#logDrawer").hidden = false;
  renderLogTabs();
  renderLogs();
}

function closeLogDrawer() {
  $("#logDrawer").hidden = true;
  stopLogPolling();
  updateShowLogBtn();
}

function renderLogTabs() {
  const container = $("#logTabs");
  const runningSet = new Set(state.running.map((r) => r.source));
  const tabs = [{ key: "__all__", label: "All" }];
  for (const source of state.logSources) {
    if (source !== "__all__") tabs.push({ key: source, label: source });
  }
  // If active tab no longer exists, fall back.
  if (!tabs.some((t) => t.key === state.logTab)) {
    state.logTab = state.logSources.find((s) => runningSet.has(s)) || "__all__";
  }
  container.innerHTML = tabs.map((t) => {
    const active = t.key === state.logTab ? " active" : "";
    const spin = t.key !== "__all__" && runningSet.has(t.key) ? ' <span class="spin">●</span>' : "";
    return `<button class="log-tab${active}" data-logtab="${esc(t.key)}">${esc(t.label)}${spin}</button>`;
  }).join("");
}

function updateShowLogBtn() {
  $("#showLogBtn").hidden = state.running.length === 0 && state.logSources.length === 0;
}

async function renderLogs() {
  const body = $("#logBody");
  if (!state.logSources.length) {
    body.innerHTML = '<p class="muted">No active run.</p>';
    return;
  }
  const runningSet = new Set(state.running.map((r) => r.source));
  // If a specific tab is selected, only render that source.
  let sources;
  if (state.logTab && state.logTab !== "__all__" && state.logSources.includes(state.logTab)) {
    sources = [state.logTab];
  } else {
    // Running sources last → the bottom-following auto-scroll always shows live output.
    sources = [...state.logSources].sort(
      (a, b) => (runningSet.has(a) ? 1 : 0) - (runningSet.has(b) ? 1 : 0),
    );
  }
  const blocks = [];
  for (const source of sources) {
    let lines = [];
    try {
      const res = await get(`/api/logs/${encodeURIComponent(source)}?tail=300`);
      lines = res.lines || [];
    } catch { lines = []; }
    const seeder = state.seeders.find((x) => x.source === source);
    const live = runningSet.has(source) ? ' <span class="spin">●</span>' : "";
    const desc = seeder?.description ? `<div class="log-desc">${esc(seeder.description)}</div>` : "";
    blocks.push(`<div class="log-source">${esc(source)}${live}</div>${desc}`);
    blocks.push(`<pre class="log-lines">${esc(lines.join("\n")) || "(no output yet)"}</pre>`);
  }
  const prevScroll = body.scrollTop;
  body.innerHTML = blocks.join("");
  // Follow the bottom unless the user has scrolled up to read (smart-follow).
  body.scrollTop = state.followLog ? body.scrollHeight : prevScroll;
}

function startLogPolling() {
  if (state.logTimer) return;
  state.wasRunning = state.running.length > 0;
  state.logTimer = setInterval(async () => {
    await loadRunning();
    const n = state.running.length;
    if (state.wasRunning && n === 0) {
      // A run (or job) just finished — refresh tables/dashboard/history once.
      await refreshAll();
      if (!$("#historyModal").hidden && state.historySource) openHistory(state.historySource);
    }
    state.wasRunning = n > 0;
    renderRunning();
    updateRunningUI();
    updateShowLogBtn();
    renderLogTabs();
    await renderLogs();
    const jobKeys = new Set((state.pipe?.jobs || []).map((j) => j.key));
    if (state.running.some((r) => jobKeys.has(r.source))) {
      await loadPipeline();
      renderPipeline();
    }
  }, 1000);
}

function stopLogPolling() {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
}

// ── schedule ────────────────────────────────────────────────────────────────
let scheduleSource = null;
let bulkSchedule = false;

function fillScheduleFields(s) {
  $("#schedCadence").innerHTML = CADENCES.map((c) =>
    `<option value="${c}" ${c === s.cadence ? "selected" : ""} title="${esc(CADENCE_TIP[c] || "")}">${c}</option>`).join("");
  $("#schedTier").value = s.isNews ? "news" : "evergreen";
  $("#schedAge").value = s.maxAgeDays || 0;
}

function openSchedule(source) {
  const s = state.seeders.find((x) => x.source === source);
  if (!s) return;
  scheduleSource = source;
  bulkSchedule = false;
  $("#schedTitle").textContent = `Schedule — ${source}`;
  fillScheduleFields(s);
  $("#scheduleModal").hidden = false;
}

function openBulkSchedule() {
  const srcs = [...state.selected];
  if (!srcs.length) { toast("Nothing selected."); return; }
  const s = state.seeders.find((x) => x.source === srcs[0]);
  if (!s) return;
  scheduleSource = srcs[0];
  bulkSchedule = true;
  $("#schedTitle").textContent = `Schedule — ${srcs.length} selected`;
  fillScheduleFields(s);
  $("#scheduleModal").hidden = false;
}

async function saveSchedule() {
  const body = {
    cadence: $("#schedCadence").value,
    isNews: $("#schedTier").value === "news",
    maxAgeDays: Number($("#schedAge").value) || null,
  };
  try {
    if (bulkSchedule) {
      const srcs = [...state.selected];
      for (const source of srcs) {
        await post("/api/schedule", { source, ...body });
      }
      toast(`Scheduled ${srcs.length} seeder(s).`);
    } else {
      await post("/api/schedule", { source: scheduleSource, ...body });
      toast(`Updated ${scheduleSource}.`);
    }
    $("#scheduleModal").hidden = true;
    await refreshAll();
  } catch (err) {
    toast("Schedule failed: " + err.message, "err");
  }
}

// ── history ─────────────────────────────────────────────────────────────────
async function openHistory(source) {
  state.historySource = source;
  $("#histTitle").textContent = `History — ${source}`;
  $("#historyModal").hidden = false;
  const runningNow = state.running.some((r) => r.source === source);
  if (runningNow) {
    $("#histBody").innerHTML = '<p class="muted"><span class="spin">●</span> Running… history is written when this run finishes.</p>';
    return;
  }
  $("#histBody").innerHTML = '<p class="muted">Loading…</p>';
  try {
    const runs = await get(`/api/history/${encodeURIComponent(source)}`);
    if (!runs.length) {
      $("#histBody").innerHTML = '<p class="muted">No runs recorded.</p>';
      return;
    }
    const errors = runs.filter((r) => r.error).map((r) => `${(r.started_at || "").slice(0, 16)}: ${r.error}`);
    $("#histBody").innerHTML = `
      <table class="hist-table">
        <thead><tr><th>Started</th><th>Status</th><th>Result</th><th>Duration</th></tr></thead>
        <tbody>${runs.map((r) => `
          <tr>
            <td>${esc((r.started_at || "").replace("T", " ").slice(0, 19))}</td>
            <td class="${r.status === "ok" ? "ok" : "err"}">${esc(r.status)}</td>
            <td>+${r.staged ?? 0} −${r.dead ?? 0} skip${r.skipped ?? 0}</td>
            <td>${fmtDur(r.duration_ms)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${errors.length ? `<p class="err-text">${esc(errors.join("\n"))}</p>` : ""}`;
  } catch (err) {
    $("#histBody").innerHTML = `<p class="err-text">${esc(err.message)}</p>`;
  }
}

// ── info ─────────────────────────────────────────────────────────────────────
function openInfo(source) {
  const s = state.seeders.find((x) => x.source === source);
  if (!s) { toast("Seeder not found.", "err"); return; }
  $("#infoTitle").textContent = s.displayName ? `${s.displayName} — ${source}` : source;
  const last = s.lastRunAt ? `${s.lastRunAt.replace("T", " ").slice(0, 19)} (${fmtAgo(s.lastRunAt)})` : "—";
  const result = s.lastResult
    ? `+${s.lastResult.staged ?? 0} −${s.lastResult.dead ?? 0} skip ${s.lastResult.skipped ?? 0}`
    : "—";
  const next = s.nextRunAt ? `${s.nextRunAt.replace("T", " ").slice(0, 19)} (${fmtIn(s.nextRunAt)})` : "—";
  const rows = [
    ["Source", s.source],
    ["Name", s.displayName || "—"],
    ["Script", s.script],
    ["Description", s.description || "—"],
    ["Category", s.categoryLabel ? `${s.categoryLabel}${s.subcategoryLabel ? " · " + s.subcategoryLabel : ""}` : "—"],
    ["Cadence", s.cadence],
    ["Tier", s.isNews ? "news (age-pruned)" : "evergreen"],
    ["Max age", s.maxAgeDays != null ? `${s.maxAgeDays} day${s.maxAgeDays === 1 ? "" : "s"}` : "none"],
    ["Access", s.access || "—"],
    ["Scheduled", s.scheduled ? "yes" : "no"],
    ["Last run", last],
    ["Last status", s.lastStatus || "—"],
    ["Last duration", s.lastDurationMs != null ? fmtElapsed(s.lastDurationMs) : "—"],
    ["Last result", result],
    ["Last error", s.lastError || "—"],
    ["Next run", next],
  ];
  $("#infoBody").innerHTML = `
    <div class="info-grid">
      ${rows.map(([k, v]) => `<div class="info-k">${esc(k)}</div><div class="info-v">${esc(v)}</div>`).join("")}
    </div>`;
  state.infoSource = source;
  const del = $("#infoDelete");
  del.dataset.confirm = "";
  del.textContent = "🗑 Delete";
  $("#infoModal").hidden = false;
}

// ── build new seeder ────────────────────────────────────────────────────────
async function loadCategories() {
  try { state.categories = await get("/api/categories"); }
  catch { state.categories = []; }
}

function fillBuildCadence() {
  $("#buildCadence").innerHTML = CADENCES.map((c) =>
    `<option value="${c}" ${c === "manual" ? "selected" : ""}>${c}</option>`).join("");
}

function populateBuildSubcategories(preserve) {
  const catName = $("#buildCategory").value;
  const cat = (state.categories || []).find((c) => c.name === catName);
  const sub = $("#buildSubcategory");
  sub.innerHTML = (cat?.subcategories || []).map((s) =>
    `<option value="${esc(s.name)}">${esc(s.label)}</option>`).join("");
  if (preserve && [...sub.options].some((o) => o.value === preserve)) sub.value = preserve;
}

function populateBuildCategories(preserveSub) {
  const cat = $("#buildCategory");
  const prev = cat.value;
  cat.innerHTML = (state.categories || []).map((c) =>
    `<option value="${esc(c.name)}">${esc(c.label)}</option>`).join("");
  if (prev && [...cat.options].some((o) => o.value === prev)) cat.value = prev;
  populateBuildSubcategories(preserveSub);
}

function openBuildModal() {
  $("#buildTitle").textContent = "New seeder";
  $("#buildUrl").value = "";
  $("#buildName").value = "";
  $("#buildSource").value = "";
  $("#buildFeed").value = "";
  $("#buildDesc").value = "";
  $("#buildPreview").textContent = "";
  fillBuildCadence();
  populateBuildCategories(null);
  $("#buildModal").hidden = false;
  $("#buildUrl").focus();
}

let buildPreviewTimer = null;
async function previewUrl() {
  const url = $("#buildUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) { $("#buildPreview").textContent = ""; return; }
  $("#buildPreview").textContent = "Fetching site metadata…";
  try {
    const meta = await post("/api/seeders/preview", { url });
    if (!$("#buildName").value) $("#buildName").value = meta.title || meta.siteName || meta.siteDomain || "";
    if (!$("#buildSource").value) $("#buildSource").value = meta.source || "";
    if (!$("#buildDesc").value) $("#buildDesc").value = meta.description || "";
    $("#buildPreview").textContent = meta.title ? `✓ ${meta.title}` : "✓ fetched";
  } catch (err) {
    $("#buildPreview").textContent = `⚠ ${err.message}`;
  }
}

async function buildSeeder() {
  const url = $("#buildUrl").value.trim();
  const category = $("#buildCategory").value;
  const subcategory = $("#buildSubcategory").value;
  if (!url) { toast("Enter a website URL.", "err"); return null; }
  if (!category || !subcategory) { toast("Pick a category and subcategory.", "err"); return null; }
  try {
    const res = await post("/api/seeders/new", {
      url,
      displayName: $("#buildName").value.trim(),
      source: $("#buildSource").value.trim(),
      category,
      subcategory,
      feedUrl: $("#buildFeed").value.trim(),
      description: $("#buildDesc").value.trim(),
      cadence: $("#buildCadence").value,
    });
    $("#buildModal").hidden = true;
    toast(`Created seeder "${res.seeder.source}".`);
    await refreshAll();
    return res.seeder.source;
  } catch (err) {
    toast("Create failed: " + err.message, "err");
    return null;
  }
}

async function removeSeeder(source) {
  try {
    await post("/api/seeders/delete", { source });
    $("#infoModal").hidden = true;
    toast(`Deleted ${source}.`);
    await refreshAll();
  } catch (err) {
    toast("Delete failed: " + err.message, "err");
  }
}

function confirmDeleteSeeder() {
  const btn = $("#infoDelete");
  const src = state.infoSource;
  if (!src) return;
  if (btn.dataset.confirm === src) { removeSeeder(src); return; }
  btn.dataset.confirm = src;
  btn.textContent = "⚠ Really delete?";
  setTimeout(() => { if (btn.dataset.confirm === src) { btn.dataset.confirm = ""; btn.textContent = "🗑 Delete"; } }, 3000);
}

async function writeTimer() {
  try {
    const t = await post("/api/timer", {});
    toast(`Timer regenerated → OnCalendar=${t.onCalendar || "—"}`);
    await renderTimer();
  } catch (err) {
    toast("Timer failed: " + err.message, "err");
  }
}

// ── navigation helpers ──────────────────────────────────────────────────────
function goToSeeders(target) {
  $("#schedFilter").value = "";
  $("#statusFilter").value = "";
  $("#tierFilter").value = "";
  if (target === "scheduled") $("#schedFilter").value = "1";
  else if (target === "due") $("#statusFilter").value = "due";
  else if (target === "errors") $("#statusFilter").value = "errors";
  showTab("seeders");
  renderSeeders();
}

// ── pipeline actions ────────────────────────────────────────────────────────
async function startPipeline(kind) {
  let jobKey = null;
  try {
    const res = await post(`/api/pipeline/${kind}`);
    jobKey = res.job;
    toast(`Started ${jobKey}.`);
  } catch (err) {
    toast(err.message, "err");
    return;
  }
  await loadRunning();
  await loadPipeline();
  renderPipeline();
  renderRunning();
  updateRunningUI();
  if (jobKey && state.running.some((r) => r.source === jobKey)) {
    openLogDrawer([jobKey]);
    startLogPolling();
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
function bind() {
  $$(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#refreshBtn").addEventListener("click", () => refreshAll());

  $("#apiBase").addEventListener("change", () => {
    state.apiBase = $("#apiBase").value.trim();
    localStorage.setItem("skyhook.apiBase", state.apiBase);
    refreshAll();
  });

  $("#live").addEventListener("change", () => {
    if ($("#live").checked) state.live = setInterval(refreshAll, 10000);
    else if (state.live) { clearInterval(state.live); state.live = null; }
  });

  $("#stats").addEventListener("click", (e) => {
    const card = e.target.closest(".stat[data-goto]");
    if (card) goToSeeders(card.dataset.goto);
  });

  $("#filter").addEventListener("input", renderSeeders);
  $("#tierFilter").addEventListener("change", renderSeeders);
  $("#schedFilter").addEventListener("change", renderSeeders);
  $("#statusFilter").addEventListener("change", renderSeeders);

  $$("#seederTable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = 1; }
      renderSeeders();
    }));

  $("#checkAll").addEventListener("change", () => {
    const on = $("#checkAll").checked;
    filtered().forEach((s) => { on ? state.selected.add(s.source) : state.selected.delete(s.source); });
    renderSeeders();
  });

  $("#seederBody").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const src = cb.dataset.source;
    cb.checked ? state.selected.add(src) : state.selected.delete(src);
    renderSeeders();
  });

  $("#seederBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, source } = btn.dataset;
    if (action === "run") await runSources([source]);
    else if (action === "schedule") openSchedule(source);
    else if (action === "info") openInfo(source);
    else if (action === "history") openHistory(source);
    else if (action === "toggle") {
      const s = state.seeders.find((x) => x.source === source);
      try {
        if (s?.scheduled) { await post("/api/disable", { source }); toast(`Disabled ${source}.`); }
        else { await post("/api/enable", { source, cadence: "weekly" }); toast(`Enabled ${source} (weekly).`); }
        await refreshAll();
      } catch (err) { toast(err.message, "err"); }
    }
  });

  $("#runSelectedBtn").addEventListener("click", () => runSources([...state.selected]));
  $("#bulkEnableBtn").addEventListener("click", bulkEnable);
  $("#bulkDisableBtn").addEventListener("click", bulkDisable);
  $("#bulkScheduleBtn").addEventListener("click", openBulkSchedule);
  $("#newSeederBtn").addEventListener("click", openBuildModal);

  $("#dueList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='run']");
    if (btn) runSources([btn.dataset.source]);
  });

  $("#failList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='run']");
    if (btn) runSources([btn.dataset.source]);
  });

  $("#runningList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action='stop-one']");
    if (btn) stopRuns(btn.dataset.source);
  });

  $("#runDueBtn").addEventListener("click", () => {
    const srcs = ($("#forceDue").checked
      ? state.seeders.filter((s) => s.scheduled)
      : state.seeders.filter(isDueClient)).map((s) => s.source);
    runSources(srcs);
  });

  $("#emitTimerBtn").addEventListener("click", writeTimer);
  $("#writeTimerBtn").addEventListener("click", writeTimer);
  $("#stopBtn").addEventListener("click", () => stopRuns());
  $("#closeLogBtn").addEventListener("click", closeLogDrawer);
  $("#showLogBtn").addEventListener("click", () => {
    const sources = state.running.length ? state.running.map((r) => r.source) : state.logSources;
    openLogDrawer(sources);
    if (state.running.length) startLogPolling();
  });
  $("#logTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("button[data-logtab]");
    if (!tab) return;
    state.logTab = tab.dataset.logtab;
    state.followLog = true;
    renderLogTabs();
    renderLogs();
  });
  $("#logBody").addEventListener("scroll", () => {
    const b = $("#logBody");
    state.followLog = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  });

  $("#schedSave").addEventListener("click", saveSchedule);
  $("#schedCancel").addEventListener("click", () => { $("#scheduleModal").hidden = true; });
  $("#histClose").addEventListener("click", () => { $("#historyModal").hidden = true; });
  $("#infoClose").addEventListener("click", () => { $("#infoModal").hidden = true; });
  $("#infoDelete").addEventListener("click", confirmDeleteSeeder);
  $("#scheduleModal").addEventListener("click", (e) => { if (e.target.id === "scheduleModal") $("#scheduleModal").hidden = true; });
  $("#historyModal").addEventListener("click", (e) => { if (e.target.id === "historyModal") $("#historyModal").hidden = true; });
  $("#infoModal").addEventListener("click", (e) => { if (e.target.id === "infoModal") $("#infoModal").hidden = true; });
  $("#buildCancel").addEventListener("click", () => { $("#buildModal").hidden = true; });
  $("#buildModal").addEventListener("click", (e) => { if (e.target.id === "buildModal") $("#buildModal").hidden = true; });
  $("#buildSave").addEventListener("click", buildSeeder);
  $("#buildTest").addEventListener("click", async () => {
    const source = await buildSeeder();
    if (source) runSources([source]);
  });
  $("#buildUrl").addEventListener("blur", () => {
    clearTimeout(buildPreviewTimer);
    buildPreviewTimer = setTimeout(previewUrl, 150);
  });
  $("#buildCategory").addEventListener("change", () => populateBuildSubcategories(null));

  $("#runTaskBtn").addEventListener("click", runTask);
  $("#pipelineCards").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-pipe]");
    if (!btn) return;
    if (btn.dataset.danger === "1" && !confirm(`Run "${btn.dataset.pipe}"? This is destructive and cannot be undone.`)) return;
    startPipeline(btn.dataset.pipe);
  });

  $("#pruneBtn").addEventListener("click", async () => {
    try {
      const filter = {};
      const src = $("#curateSource").value.trim();
      const before = $("#curateBefore").value;
      if (src) filter.source = src;
      if (before) filter.before = before;
      const r = await post("/api/cache/prune", { filter });
      toast(`Deleted ${r.deleted} staged URL(s) (kept ${r.kept}).`);
      renderCuration();
    } catch (err) { toast(err.message, "err"); }
  });

  $("#curateRefreshBtn").addEventListener("click", renderCuration);

  $("#curationBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, source } = btn.dataset;
    try {
      if (action === "clear-staged") { await post("/api/cache/clear", { source }); toast(`Cleared staged for ${source}.`); }
      else if (action === "clear-discovery") { await post("/api/cache/clear", { source, kind: "discovery" }); toast(`Cleared discovery cache for ${source}.`); }
      renderCuration();
    } catch (err) { toast(err.message, "err"); }
  });
}

async function init() {
  $("#apiBase").value = state.apiBase;
  $("#apiLabel").textContent = `api → ${apiBase()}`;
  bind();
  await loadCategories();
  await refreshAll();
}

init();
