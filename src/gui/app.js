/* Skyhook Control — browser GUI over the skyhook HTTP API.
 * Zero dependencies; served from src/gui/ by interfaces/api-server.js. */

"use strict";

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

const debounce = (fn, ms = 100) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

const CADENCES = ["hourly", "6h", "12h", "daily", "weekly", "monthly", "manual"];
const CADENCE_MS = {
  hourly: 3600e3, "6h": 6*3600e3, "12h": 12*3600e3,
  daily:  24*3600e3, weekly: 7*24*3600e3, monthly: 30*24*3600e3, manual: Infinity,
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
const GAP_LABELS = {
  category: "Missing categories", subcategory: "Missing subcategories",
  tags: "Untagged URLs", contentType: "Missing content types",
  quality: "Missing quality", attributes: "Missing attributes",
};

const state = {
  seeders: [], running: [], batch: null, pipe: null,
  sortKey: "source", sortDir: 1, selected: new Set(),
  apiBase: localStorage.getItem("skyhook.apiBase") || "",
  live: null, _liveWired: false, logSources: [], followLog: true, userTab: null,
  historySource: null, wasRunning: false, categories: [],
  infoSource: null, taggingGaps: null, tagTasks: [],
  route: { name: "dashboard", params: {} },
  nodeId: "local",
};

const apiBase = () => {
  if (state.apiBase.trim()) return state.apiBase.trim().replace(/\/+$/, "");
  return window.location.origin;
};

const REQUEST_TIMEOUT_MS = 15000;
async function api(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase() + path, {
      method, signal: ctrl.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; } }
    if (!res.ok) throw new Error(data.error || res.status + " " + res.statusText);
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out (15s)");
    throw err;
  } finally { clearTimeout(t); }
}
const get  = (p)    => api("GET", p);
const post = (p, b) => api("POST", p, b || {});

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function fmtIn(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "due";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "in " + s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return "in " + m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return "in " + h + "h";
  return "in " + Math.floor(h / 24) + "d";
}
const fmtElapsed = (ms) => {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
};
const resultText = (r) => (r ? ("+" + (r.staged ?? 0) + " âˆ’" + (r.dead ?? 0)) : "");
const fmtEta = (ms) => {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
};
function isDueClient(s) {
  if (!s.scheduled || s.cadence === "manual") return false;
  if (!s.lastRunAt) return true;
  const ms = CADENCE_MS[s.cadence] ?? CADENCE_MS.weekly;
  if (!isFinite(ms)) return false;
  return Date.now() - new Date(s.lastRunAt).getTime() >= ms;
}
function isErrorStatus(s) {
  return s.lastStatus && s.lastStatus !== "ok" && s.lastRunAt;
}

let toasts = [];
function toast(msg, kind) {
  const region = $("#toastRegion");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  const iconId = kind === "err" ? "ic-warning" : kind === "ok" ? "ic-check" : "ic-bell";
  el.innerHTML =
    '<svg class="ic" aria-hidden="true"><use href="#' + iconId + '"/></svg>' +
    '<div class="body"></div>' +
    '<button class="close" type="button" aria-label="Dismiss">' +
    '<svg class="ic" aria-hidden="true"><use href="#ic-x"/></svg>' +
    '</button>';
  el.querySelector(".body").textContent = msg;
  const remove = () => {
    el.style.transition = "opacity .15s, transform .15s";
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => { el.remove(); toasts = toasts.filter((t) => t !== el); }, 160);
  };
  el.querySelector(".close").addEventListener("click", remove);
  region.appendChild(el);
  toasts.push(el);
  setTimeout(remove, 4500);
}

let activeModal = null, lastFocus = null, modalKeyHandler = null;
function openModal(build) {
  closeModal();
  lastFocus = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("tabindex", "-1");
  build(modal, closeModal);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  $("#modalRoot").appendChild(backdrop);
  activeModal = backdrop;
  const focusable = modal.querySelector("input, select, textarea, button, [tabindex]");
  if (focusable) focusable.focus();
  modalKeyHandler = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key !== "Tab") return;
    const all = [...modal.querySelectorAll("input, select, textarea, button, [tabindex]")]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", modalKeyHandler);
}
function closeModal() {
  if (!activeModal) return;
  activeModal.remove();
  activeModal = null;
  if (modalKeyHandler) document.removeEventListener("keydown", modalKeyHandler);
  modalKeyHandler = null;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function modalShell(modal, opts) {
  const head = document.createElement("div");
  head.className = "modal-head";
  const h = document.createElement("h3");
  h.textContent = opts.title;
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#ic-x"/></svg>';
  close.addEventListener("click", closeModal);
  head.append(h, close);
  modal.appendChild(head);
  if (opts.body) {
    const m = document.createElement("div");
    m.className = "modal-body";
    if (typeof opts.body === "string") m.innerHTML = opts.body;
    else m.appendChild(opts.body);
    modal.appendChild(m);
  }
  if (opts.actions) {
    const foot = document.createElement("div");
    foot.className = "modal-foot";
    opts.actions.forEach((a) => foot.appendChild(a));
    modal.appendChild(foot);
  }
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "dashboard", params: {} };
  if (parts[0] === "seeders") return { name: "seeders", params: {} };
  if (parts[0] === "log") return { name: "log", params: { source: parts[1] ? decodeURIComponent(parts[1]) : null } };
  if (parts[0] === "pipeline") return { name: "pipeline", params: {} };
  if (parts[0] === "stats") return { name: "stats", params: {} };
  if (parts[0] === "curation") return { name: "curation", params: {} };
  if (parts[0] === "timer") return { name: "timer", params: {} };
  if (parts[0] === "settings") return { name: "settings", params: {} };
  return { name: "dashboard", params: {} };
}
function navigate(hash) {
  if (window.location.hash === hash) handleRouteChange();
  else window.location.hash = hash;
}
function isPiNode() { return /pi/i.test(state.nodeId || ""); }
function applyNodeVisibility() {
  const show = isPiNode();
  $$("[data-pi-only]").forEach((el) => { el.style.display = show ? "" : "none"; });
  if (!show && state.route.name === "timer") navigate("#/");
}
function handleRouteChange() {
  const r = parseRoute();
  state.route = r;
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.route === r.name));
  $$(".sidenav-item, .bn-item").forEach((el) => el.classList.toggle("active", el.dataset.route === r.name));
  if (r.name === "timer" && !isPiNode()) { navigate("#/"); return; }
  if (r.name === "dashboard") renderDashboard();
  if (r.name === "seeders") renderSeeders();
  if (r.name === "pipeline") renderPipeline();
  if (r.name === "stats") renderAnalytics();
  if (r.name === "curation") renderCuration();
  if (r.name === "settings") renderSettings();
  if (r.name === "timer") renderTimer();
  if (r.name === "log") {
    // If no specific source, fall back to the first running seeder (or the
    // most recent log source) so the mobile "Logs" nav item always lands.
    const src = r.params.source || (state.running[0] && state.running[0].source) || logPageState.source;
    openLogPage(src);
  }
  if (r.name !== "log") closeLogPage();
}

async function loadSeeders()    { state.seeders = await get("/api/seeders?limit=5000"); }
async function loadRunning()    { const r = await get("/api/running").catch(() => ({ running: [] })); state.running = r.running || []; state.batch = r.batch || null; }
async function loadPipeline()   { state.pipe = await get("/api/pipeline").catch(() => null); }

function filtered() {
  const f     = $("#filter").value.trim().toLowerCase();
  const tier  = $("#tierFilter").value;
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
  if (tier === "news")      rows = rows.filter((s) => s.isNews);
  if (tier === "evergreen") rows = rows.filter((s) => !s.isNews);
  if (sched === "1")        rows = rows.filter((s) => s.scheduled);
  if (sched === "0")        rows = rows.filter((s) => !s.scheduled);
  if (status === "due")     rows = rows.filter(isDueClient);
  if (status === "errors")  rows = rows.filter(isErrorStatus);
  return rows;
}
function sorted(rows) {
  const k = state.sortKey;
  return [...rows].sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return cmp * state.sortDir;
  });
}

function renderSeeders() {
  const rows = sorted(filtered());
  const countLabel = $("#countLabel");
  if (countLabel) countLabel.textContent = rows.length + " / " + state.seeders.length;
  const runningSet = new Set(state.running.map((r) => r.source));
  const badge = $("#seederCountBadge");
  if (badge) badge.textContent = state.seeders.length;
  const tbody = $("#seederBody");
  tbody.innerHTML = "";
  for (const s of rows) {
    const tr = document.createElement("tr");
    const statusCls = s.lastStatus === "ok" ? "ok" : s.lastStatus ? "err" : "";
    const result = resultText(s.lastResult);
    const isRunning = runningSet.has(s.source);
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" data-source="' + esc(s.source) + '"' + (state.selected.has(s.source) ? " checked" : "") + ' aria-label="Select ' + esc(s.source) + '"></td>' +
      '<td><a class="row-link" href="#/log/' + encodeURIComponent(s.source) + '">' + esc(s.source) + (isRunning ? ' <span class="spin-pulse" aria-label="running"></span>' : "") + '</a></td>' +
      '<td class="muted">' + esc(s.displayName || "") + '</td>' +
      '<td class="muted">' + esc(s.categoryLabel || "") + (s.subcategoryLabel ? " · " + esc(s.subcategoryLabel) : "") + '</td>' +
      '<td><span class="cadence ' + (s.scheduled ? "" : "manual") + '" title="' + esc(CADENCE_TIP[s.cadence] || "") + '">' + esc(s.cadence) + '</span></td>' +
      '<td><span class="tier ' + (s.isNews ? "news" : "evergreen") + '">' + (s.isNews ? "news" : "evergreen") + '</span></td>' +
      '<td class="muted">' + esc(fmtAgo(s.lastRunAt)) + '</td>' +
      '<td class="' + statusCls + '">' + esc(result || (s.lastError ? s.lastError : s.lastStatus || "—")) + '</td>' +
      '<td class="muted">' + esc(fmtIn(s.nextRunAt)) + '</td>' +
      '<td class="col-actions">' +
        '<button class="icon-btn sm" data-action="run" data-source="' + esc(s.source) + '" aria-label="Run ' + esc(s.source) + '" title="Run now"><svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg></button>' +
        '<button class="icon-btn sm" data-action="schedule" data-source="' + esc(s.source) + '" aria-label="Edit schedule" title="Edit schedule"><svg class="ic" aria-hidden="true"><use href="#ic-cog"/></svg></button>' +
        '<button class="icon-btn sm" data-action="toggle" data-source="' + esc(s.source) + '" aria-label="Toggle schedule" title="' + (s.scheduled ? "Disable" : "Enable") + '"><svg class="ic" aria-hidden="true"><use href="#ic-power"/></svg></button>' +
      '</td>';
    tbody.appendChild(tr);
  }

  const cardsEl = $("#seederCards");
  if (cardsEl) {
    cardsEl.innerHTML = rows.map((s) => {
      const statusCls = s.lastStatus === "ok" ? "ok" : s.lastStatus ? "err" : "never";
      const result = resultText(s.lastResult);
      const isRunning = runningSet.has(s.source);
      return (
        '<div class="seeder-card' + (isRunning ? " running" : "") + '">' +
          '<div class="sc-head">' +
            '<div class="sc-check"><input type="checkbox" data-source="' + esc(s.source) + '"' + (state.selected.has(s.source) ? " checked" : "") + ' aria-label="Select ' + esc(s.source) + '"></div>' +
            '<div class="sc-title">' +
              '<a class="sc-source" href="#/log/' + encodeURIComponent(s.source) + '">' + esc(s.source) + (isRunning ? ' <span class="spin-pulse" aria-label="running"></span>' : "") + '</a>' +
              '<div class="sc-name">' + esc(s.displayName || "") + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="sc-meta">' +
            '<span>' + esc(s.categoryLabel || "") + (s.subcategoryLabel ? " · " + esc(s.subcategoryLabel) : "") + '</span>' +
            '<span class="cadence ' + (s.scheduled ? "" : "manual") + '">' + esc(s.cadence) + '</span>' +
            '<span class="tier ' + (s.isNews ? "news" : "evergreen") + '">' + (s.isNews ? "news" : "evergreen") + '</span>' +
          '</div>' +
          '<div class="sc-status ' + statusCls + '">' + esc(s.lastStatus || "never run") + '</div>' +
          '<div class="sc-result">' + esc(result || (s.lastError ? s.lastError : "—")) + '</div>' +
          '<div class="sc-actions">' +
            '<button class="btn btn-sm" data-action="run" data-source="' + esc(s.source) + '"><svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg><span>Run</span></button>' +
            '<button class="btn btn-sm" data-action="schedule" data-source="' + esc(s.source) + '">Schedule</button>' +
            '<button class="btn btn-sm" data-action="toggle" data-source="' + esc(s.source) + '">' + (s.scheduled ? "Disable" : "Enable") + '</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  updateBulkBar();
}
function updateBulkBar() {
  const checkAll = $("#checkAll");
  const rows = filtered();
  if (checkAll) checkAll.checked = rows.length > 0 && rows.every((s) => state.selected.has(s.source));
  const sel = state.selected.size;
  const runBtn = $("#runSelectedBtn");
  if (runBtn) runBtn.disabled = sel === 0;
  const enableBtn = $("#bulkEnableBtn");
  const disableBtn = $("#bulkDisableBtn");
  if (enableBtn)  enableBtn.disabled  = sel === 0;
  if (disableBtn) disableBtn.disabled = sel === 0;
  const selCount = $("#selectedCount");
  if (selCount) selCount.textContent = sel ? (sel + " selected") : "";
}

function isLlmSource(source) {
  return source === "tag" || source === "retag-add" || source === "retag-replace" ||
    (typeof source === "string" && source.startsWith("task:"));
}
const LLM_LABELS = {
  tag: "LLM-Tagging",
  "retag-add": "LLM-Tagging (2nd pass: add)",
  "retag-replace": "LLM-Tagging (2nd pass: replace)",
  "task:fill-category": "LLM-Fill-Categories",
  "task:fill-subcategory": "LLM-Fill-Subcategories",
  "task:fill-tags": "LLM-Fill-Tags",
  "task:fill-content-type": "LLM-Fill-Content-Types",
  "task:fill-quality": "LLM-Fill-Quality",
  "task:fill-attributes": "LLM-Fill-Attributes",
};
function llmLabel(source) {
  return LLM_LABELS[source] ||
    (typeof source === "string" && source.startsWith("task:") ? "LLM-" + source.slice(5) : "LLM-Tagging");
}
function runRow(label, r, isHeartbeat) {
  const logHref = isHeartbeat ? "#/log/tagger" : "#/log/" + encodeURIComponent(r.source);
  let html =
    '<div class="due-row">' +
      '<span class="spin-pulse"></span>' +
      '<strong>' + esc(label) + '</strong>' +
      '<span class="muted">' + (isHeartbeat ? "running" : esc(fmtElapsed(r.elapsedMs))) + '</span>' +
      '<a class="btn btn-sm" href="' + logHref + '">View log</a>';
  if (!isHeartbeat) {
    html +=
      '<button class="icon-btn sm" data-stop-one="' + esc(r.source) + '" aria-label="Stop ' + esc(r.source) + '" title="Stop">' +
        '<svg class="ic" aria-hidden="true"><use href="#ic-stop"/></svg>' +
      '</button>';
  }
  return html + '</div>';
}

function renderDashboard() {
  const total = state.seeders.length;
  const scheduled = state.seeders.filter((s) => s.scheduled).length;
  const due = state.seeders.filter(isDueClient).length;
  const errors = state.seeders.filter(isErrorStatus).length;
  $("#dashStats").innerHTML =
    '<a class="stat" href="#/seeders" data-jump="all"><span class="stat-num">' + total + '</span><span class="stat-label">seeders</span></a>' +
    '<a class="stat ok" href="#/seeders" data-jump="scheduled"><span class="stat-num">' + scheduled + '</span><span class="stat-label">scheduled</span></a>' +
    '<a class="stat ' + (due ? "warn" : "") + '" href="#/seeders" data-jump="due"><span class="stat-num">' + due + '</span><span class="stat-label">due now</span></a>' +
    '<a class="stat ' + (errors ? "err" : "") + '" href="#/seeders" data-jump="errors"><span class="stat-num">' + errors + '</span><span class="stat-label">errors</span></a>';
  $("#dashStats").onclick = (e) => {
    const card = e.target.closest("[data-jump]");
    if (!card) return;
    e.preventDefault();
    const t = card.dataset.jump;
    if (t === "scheduled") $("#schedFilter").value = "1";
    else if (t === "due") $("#statusFilter").value = "due";
    else if (t === "errors") $("#statusFilter").value = "errors";
    else { $("#schedFilter").value = ""; $("#statusFilter").value = ""; }
    navigate("#/seeders");
  };

  const runningEl = $("#runningList");
  const workerRunning = state.pipe && /Worker status:\s*running/i.test(state.pipe.note || "");
  const llmRunning = state.running.filter((r) => isLlmSource(r.source));
  const otherRunning = state.running.filter((r) => !isLlmSource(r.source));
  const items = [];
  // Show the LLM worker exactly once. Prefer the server-known run (it carries
  // the task key, e.g. task:fill-category); fall back to the DB heartbeat for
  // workers launched outside the server.
  if (llmRunning.length) {
    for (const r of llmRunning) items.push(runRow(llmLabel(r.source), r, false));
  } else if (workerRunning) {
    items.push(runRow("LLM-Tagging", null, true));
  }
  for (const r of otherRunning) items.push(runRow(r.source, r, false));
  if (items.length) {
    runningEl.innerHTML = items.join("");
  } else {
    runningEl.innerHTML = '<p class="muted" style="padding: var(--space-3);">Nothing running.</p>';
  }

  const failEl = $("#failList");
  const fails = state.seeders.filter(isErrorStatus).sort((a, b) => (b.lastRunAt || "").localeCompare(a.lastRunAt || ""));
  if (fails.length) {
    failEl.innerHTML = fails.slice(0, 30).map((s) =>
      '<div class="due-row">' +
        '<a class="row-link" href="#/log/' + encodeURIComponent(s.source) + '">' + esc(s.source) + '</a>' +
        '<span class="badge err">' + esc(s.lastStatus || "error") + '</span>' +
        '<span class="muted" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + esc(s.lastError || "") + '</span>' +
        '<span class="muted">' + esc(fmtAgo(s.lastRunAt)) + '</span>' +
        '<button class="icon-btn sm" data-action="run" data-source="' + esc(s.source) + '" aria-label="Retry ' + esc(s.source) + '" title="Retry now">' +
          '<svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg>' +
        '</button>' +
      '</div>').join("");
  } else {
    failEl.innerHTML = '<p class="muted" style="padding: var(--space-3);">No failures. ✓</p>';
  }

  const dueNow = state.seeders.filter(isDueClient);
  const dueEl = $("#dueList");
  if (dueNow.length) {
    dueEl.innerHTML = dueNow.slice(0, 60).map((s) =>
      '<div class="due-row">' +
        '<a class="row-link" href="#/log/' + encodeURIComponent(s.source) + '" title="' + esc(s.script || "") + '">' + esc(s.source) + '</a>' +
        '<span class="muted">' + esc(s.cadence) + '</span>' +
        '<span class="muted">last ' + esc(fmtAgo(s.lastRunAt)) + '</span>' +
        '<button class="icon-btn sm" data-action="run" data-source="' + esc(s.source) + '" aria-label="Run ' + esc(s.source) + '">' +
          '<svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg>' +
        '</button>' +
      '</div>').join("");
  } else {
    dueEl.innerHTML = '<p class="muted" style="padding: var(--space-3);">Nothing due right now.</p>';
  }

  renderBatchProgress();
}

function renderBatchProgress() {
  const el = $("#batchProgress");
  if (!el) return;
  const b = state.batch;
  if (!b || !b.total) { el.innerHTML = ""; return; }
  const pct = b.total ? Math.min(100, Math.round((b.completed / b.total) * 100)) : 0;
  const eta = b.etaMs != null && isFinite(b.etaMs) ? fmtEta(b.etaMs) : "—";
  el.innerHTML =
    '<div class="card" style="margin-top: var(--space-2);">' +
      '<div class="bar-row">' +
        '<span class="bar-label">Batch</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="bar-count">' + b.completed.toLocaleString() + '/' + b.total.toLocaleString() + ' · ETA ' + esc(eta) + '</span>' +
      '</div>' +
    '</div>';
}

async function loadSettings()   { const s = await get("/api/settings").catch(() => null); if (s) { state.nodeId = (s.node && s.node.id) || "local"; applyNodeVisibility(); } return s; }
async function loadCategories() { state.categories = await get("/api/categories").catch(() => []); }

function gapCards(g) {
  if (!g) return '<p class="muted">No offline DB available.</p>';
  const order = ["category", "subcategory", "tags", "contentType", "quality", "attributes"];
  return order.map((k) => {
    const n = (g.missing && g.missing[k]) ?? 0;
    return '<div class="stat" style="cursor: default;"><span class="stat-num">' + Number(n).toLocaleString() + '</span><span class="stat-label">' + GAP_LABELS[k] + '</span></div>';
  }).join("");
}

async function loadTaggingGaps() {
  const g = await get("/api/tagging/missing").catch(() => null);
  state.taggingGaps = g;
  return g;
}

async function renderPipeline() {
  await loadPipeline();
  const p = state.pipe || {};
  const cards = Array.isArray(p.cards) ? p.cards : [];
  const jobs = Array.isArray(p.jobs) ? p.jobs : [];
  const cardsEl = $("#pipelineCards");
  if (cardsEl) {
    cardsEl.innerHTML = cards.length
      ? cards.map((c) =>
          '<div class="pipe-card">' +
            '<div class="pipe-stat">' +
              '<span class="pipe-value">' + esc(c.value ?? "—") + '</span>' +
              '<span class="pipe-label">' + esc(c.label ?? c.id) + '</span>' +
            '</div>' +
            (c.sub ? '<div class="pipe-sub">' + esc(c.sub) + '</div>' : "") +
            '<div class="pipe-actions">' +
              (Array.isArray(c.actions) ? c.actions : []).map((a) =>
                '<button class="btn btn-sm ' + (a.danger ? "btn-danger" : "btn-primary") + '" data-pipe="' + esc(a.kind ?? a.id) + '" data-danger="' + (a.danger ? "1" : "0") + '">' +
                  '<svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg>' +
                  '<span>' + esc(a.label ?? a.id) + '</span>' +
                '</button>').join("") +
            '</div>' +
          '</div>').join("")
      : '<p class="muted">No pipeline status.</p>';
  }
  const jobsEl = $("#pipelineJobs");
  if (jobsEl) {
    jobsEl.innerHTML = jobs.length
      ? jobs.map((j) =>
          '<div class="job-row">' +
            '<span class="job-status ' + esc(j.status || "idle") + '"></span>' +
            '<span>' + esc(j.label || j.key) + '</span>' +
          '</div>').join("")
      : '<p class="muted">No pipeline jobs.</p>';
  }
  await loadTaggingGaps();
  if (state.taggingGaps) $("#taggingGaps").innerHTML = gapCards(state.taggingGaps);
  renderPipelineStatus(p);
  await renderTaggingTasks();
}

function renderPipelineStatus(p) {
  // Note text (fallback).
  const note = $("#pipelineNote");
  if (note) note.textContent = p.note || "";

  // Tagging progress bar + metric chips.
  const progEl = $("#pipelineProgress");
  const metricsEl = $("#pipelineMetrics");

  if (progEl) {
    if (p.progress && p.progress.total) {
      const pct = Math.min(100, Number(p.progress.pct) || 0);
      progEl.style.display = "";
      progEl.innerHTML =
        '<div class="bar-row">' +
          '<span class="bar-label">Tagging</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="bar-count">' + Number(p.progress.done).toLocaleString() + ' of ' + Number(p.progress.total).toLocaleString() + ' · ' + pct + '%</span>' +
        '</div>';
    } else {
      progEl.style.display = "none";
      progEl.innerHTML = "";
    }
  }

  if (metricsEl) {
    const chips = [];
    const m = Array.isArray(p.metrics) ? p.metrics : [];
    for (const x of m) {
      chips.push(
        '<span class="metric-chip">' +
          '<span class="metric-k">' + esc(x.label) + '</span>' +
          '<span class="metric-v">' + esc(x.value) + '</span>' +
        '</span>');
    }
    if (p.progress && p.progress.workerStatus) {
      const running = p.progress.workerStatus === "running";
      chips.push(
        '<span class="metric-chip ' + (running ? "worker-running" : "worker-stopped") + '">' +
          '<span class="metric-k">Worker</span>' +
          '<span class="metric-v">' + (running ? "running" : "stopped") + '</span>' +
        '</span>');
    }
    if (chips.length) {
      metricsEl.style.display = "";
      metricsEl.innerHTML = chips.join("");
    } else {
      metricsEl.style.display = "none";
      metricsEl.innerHTML = "";
    }
  }
}

async function renderTaggingTasks() {
  const GT = ">";
  const [g, tasksRes, modelsRes] = await Promise.all([
    loadTaggingGaps(),
    get("/api/tagging/tasks").catch(() => null),
    get("/api/tagging/models").catch(() => null),
  ]);
  const missing = (g && g.missing) || {};
  const FALLBACK_TASKS = [
    { key: "fill-category", label: "Fill missing categories", gap: "category" },
    { key: "fill-subcategory", label: "Fill missing subcategories", gap: "subcategory" },
    { key: "fill-tags", label: "Add tags to untagged URLs", gap: "tags" },
    { key: "fill-content-type", label: "Fill missing content types", gap: "contentType" },
    { key: "fill-quality", label: "Fill missing quality", gap: "quality" },
    { key: "fill-attributes", label: "Fill missing attributes", gap: "attributes" },
  ];
  state.tagTasks = (tasksRes && Array.isArray(tasksRes.tasks)) ? tasksRes.tasks : FALLBACK_TASKS;
  const tasks = state.tagTasks;

  const sel = $("#tagTask");
  const prev = sel && sel.value;
  if (sel) {
    sel.innerHTML = '<option value=""' + GT + 'Select a task…' + '</option' + GT + tasks.map((t) => {
      let suffix = "";
      if (t.gap && missing[t.gap] != null) suffix = " (" + Number(missing[t.gap]).toLocaleString() + ")";
      else if (t.reprocess) suffix = " — recheck";
      else if (t.minTags != null) suffix = " — min " + t.minTags + " tags";
      return '<option value="' + esc(t.key) + '"' + GT + esc(t.label) + suffix + '</option' + GT;
    }).join("");
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  const mSel = $("#tagModel");
  const mPrev = mSel && mSel.value;
  const models = (modelsRes && Array.isArray(modelsRes.models)) ? modelsRes.models : [];
  const configured = modelsRes && modelsRes.configured;
  if (mSel) {
    const defLabel = configured ? ("Configured model (" + configured + ")") : "Configured model";
    const opts = ['<option value=""' + GT + esc(defLabel) + '</option' + GT];
    for (const m of models) {
      opts.push(
        '<option value="' + esc(m.id) + '" data-provider="' + esc(m.provider || "") + '" data-instance="' + esc(m.instanceId || "") + '"' + GT +
          esc(m.label || m.id) + (m.isLoaded ? " (loaded)" : "") + '</option' + GT);
    }
    mSel.innerHTML = opts.join("");
    if (mPrev && [...mSel.options].some((o) => o.value === mPrev)) mSel.value = mPrev;
    else if (configured && [...mSel.options].some((o) => o.value === configured)) mSel.value = configured;
  }

  // Hint: tell the user why models might be missing.
  const hint = $("#tagModelHint");
  if (hint) {
    if (!models.length) {
      const err = (modelsRes && modelsRes.errors && modelsRes.errors[0]) || "";
      hint.style.display = "";
      hint.textContent = "⚠ No models detected — is your platform running?" + (err ? " (" + err + ")" : "");
    } else {
      hint.style.display = "none";
      hint.textContent = "";
    }
  }

  syncTagMinTags();
  const runBtn = $("#runTaskBtn");
  if (runBtn) runBtn.disabled = false;
}

function syncTagMinTags() {
  const wrap = $("#tagMinTagsWrap");
  const input = $("#tagMinTags");
  if (!wrap || !input) return;
  const taskKey = $("#tagTask") && $("#tagTask").value;
  const t = state.tagTasks.find((x) => x.key === taskKey);
  const show = !!(t && t.minTags != null);
  wrap.style.display = show ? "" : "none";
  if (show && t.minTags && !input.value) input.value = t.minTags;
}

/** Returns { model, provider } from the currently selected model option. */
function selectedModel() {
  const mSel = $("#tagModel");
  const model = mSel && mSel.value ? mSel.value : null;
  const provider = model && mSel.selectedIndex >= 0 && mSel.options[mSel.selectedIndex]
    ? (mSel.options[mSel.selectedIndex].dataset.provider || null) : null;
  return { model, provider };
}

async function loadSelectedModel() {
  const { model, provider } = selectedModel();
  if (!model) { toast("Pick a model first.", "err"); return false; }
  const btn = $("#loadModelBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin-pulse" aria-hidden="true"></span><span>Loading…</span>'; }
  try {
    const res = await post("/api/tagging/models/load", { model, provider: provider || undefined });
    toast("Model ready: " + model + (res.alreadyLoaded ? " (was already loaded)." : " (loaded in " + (res.loadTimeSeconds ?? "?") + "s)."), "ok");
    await renderTaggingTasks();
    return true;
  } catch (err) {
    toast("Load failed: " + err.message, "err");
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#ic-refresh"/></svg><span>Load model</span>'; }
  }
}

async function runTask() {
  const taskSel = $("#tagTask");
  const task = taskSel && taskSel.value;
  if (!task) { toast("Select a task first.", "err"); return; }
  const t = state.tagTasks.find((x) => x.key === task);
  const { model, provider } = selectedModel();
  // If the user picked a specific model (not "Configured model"), make sure it's
  // loaded into memory first (ejects any other loaded model, then loads ours).
  if (model) {
    const loaded = await loadSelectedModel();
    if (!loaded) return;
  }
  const body = { task };
  if (model) body.model = model;
  if (provider) body.provider = provider;
  if (t && t.minTags != null) {
    const n = parseInt(($("#tagMinTags") && $("#tagMinTags").value) || "", 10);
    if (Number.isFinite(n) && n > 0) body.minTags = n;
  }
  try {
    const res = await post("/api/tagging/run", body);
    toast("Started " + res.task + ".", "ok");
    navigate("#/log/" + encodeURIComponent(res.job));
  } catch (err) { toast(err.message, "err"); }
}

async function renderTimer() {
  const t = await get("/api/timer").catch(() => null);
  if (!t) { $("#timerOnCalendar").textContent = "unavailable"; return; }
  $("#timerOnCalendar").textContent = t.onCalendar || "—";
  $("#timerCadence").textContent = t.fastestCadence || "—";
  $("#timerUnit").textContent = t.unit || "";
}

function barRow(label, count, pct) {
  return '<div class="bar-row">' +
    '<span class="bar-label">' + esc(label) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + Math.min(100, pct) + '%"></span></span>' +
    '<span class="bar-count">' + count.toLocaleString() + ' · ' + pct + '%</span>' +
  '</div>';
}

async function renderAnalytics() {
  try {
    const s = await get("/api/stats");
    $("#analyticsCards").innerHTML =
      '<div class="stat" style="cursor: default;"><span class="stat-num">' + s.total.toLocaleString() + '</span><span class="stat-label">staged URLs</span></div>' +
      '<div class="stat" style="cursor: default;"><span class="stat-num">' + s.seeders.toLocaleString() + '</span><span class="stat-label">seeders</span></div>';
    const list = (title, arr, limit) =>
      (arr.length ? '<h3 class="h-section">' + title + '</h3>' + arr.slice(0, limit || arr.length).map((r) => barRow(r.label || r.key, r.count, r.pct)).join("") : "");
    $("#analyticsBody").innerHTML = s.total
      ? list("By seeder", s.bySource, 25) + list("By category", s.byCategory) + list("By subcategory", s.bySubcategory, 25) + list("By language", s.byLanguage)
      : '<p class="muted">No staged results yet.</p>';
    await loadTaggingGaps();
    if (state.taggingGaps) $("#statsGaps").innerHTML = gapCards(state.taggingGaps);
  } catch (err) {
    $("#analyticsBody").innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
  }
}

async function renderCuration() {
  try {
    const c = await get("/api/cache");
    const stageRows = (c.staged || []).reduce((n, f) => n + f.count, 0);
    const body = $("#curationBody");

    const stagedSection = (c.staged || []).length
      ? '<div class="curate-section">' +
          '<h2 class="h-section">Staged (' + c.staged.length + ' sources, ' + stageRows.toLocaleString() + ' rows)</h2>' +
          (c.staged || []).map((f) =>
            '<div class="curate-row">' +
              '<div class="info">' +
                '<div class="name">' + esc(f.originalSource !== f.source ? f.originalSource : f.source) + '</div>' +
                (f.originalSource !== f.source ? '<div class="meta">file: ' + esc(f.source) + '</div>' : "") +
              '</div>' +
              '<div class="stat">' +
                '<span class="count">' + f.count.toLocaleString() + '</span>' +
                '<span class="bytes">' + (f.bytes / 1024).toFixed(1) + ' KB</span>' +
              '</div>' +
              '<div class="actions">' +
                '<button class="btn btn-sm" data-action="clear-discovery" data-source="' + esc(f.originalSource) + '">Clear discovery</button>' +
                '<button class="btn btn-sm btn-danger" data-action="clear-staged" data-source="' + esc(f.originalSource) + '">Clear staged</button>' +
              '</div>' +
            '</div>').join("") +
        '</div>'
      : '<h2 class="h-section">Staged</h2><p class="muted">No staged results.</p>';

    const discoverySection = (c.discovery || []).length
      ? '<div class="curate-section">' +
          '<h2 class="h-section">Discovery cache (' + c.discovery.length + ' files)</h2>' +
          (c.discovery || []).map((d) =>
            '<div class="curate-row">' +
              '<div class="info"><div class="name">' + esc(d.source) + '</div></div>' +
              '<div class="stat"><span class="bytes">' + (d.bytes / 1024).toFixed(1) + ' KB</span></div>' +
            '</div>').join("") +
        '</div>'
      : '';

    body.innerHTML = stagedSection + discoverySection;
  } catch (err) {
    $("#curationBody").innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
  }
}

async function renderSettings() {
  const body = $("#settingsBody");
  try {
    const s = await get("/api/settings");
    const peers = s.remote && s.remote.peers && s.remote.peers.length
      ? s.remote.peers.map((p) => '<li><code>' + esc(p.id) + '</code> → ' + esc(p.url) + '</li>').join("")
      : "<li class='muted'>(none)</li>";
    body.innerHTML =
      '<div class="grid grid-stats mb-4">' +
        '<div class="stat" style="cursor: default;"><span class="stat-num">' + esc((s.node && s.node.id) || "—") + '</span><span class="stat-label">node id</span></div>' +
        '<div class="stat ' + ((s.node && s.node.allowRemote) ? "warn" : "ok") + '" style="cursor: default;"><span class="stat-num">' + ((s.node && s.node.allowRemote) ? "ON" : "OFF") + '</span><span class="stat-label">remote control</span></div>' +
        '<div class="stat" style="cursor: default;"><span class="stat-num">' + (s.remote && s.remote.hasToken ? "set" : "—") + '</span><span class="stat-label">token</span></div>' +
      '</div>' +
      '<p>' + ((s.node && s.node.allowRemote) ? "This node is a <strong>worker</strong> — it accepts remote control from a master." : "This node is <strong>standalone</strong> — a normal seeder manager.") + '</p>' +
      '<h2 class="h-section">Peers</h2>' +
      '<ul style="padding-left: var(--space-5); line-height: 1.8;">' + peers + '</ul>' +
      '<h2 class="h-section">Tagging platform</h2>' +
      '<div class="field">' +
        '<label for="taggingPlatform">LLM platform</label>' +
        '<select id="taggingPlatform">' +
          ((s.tagging && Array.isArray(s.tagging.platforms) ? s.tagging.platforms : [])
            .map((p) => '<option value="' + esc(p.id) + '"' + (s.tagging && s.tagging.activePlatform === p.id ? " selected" : "") + '>' + esc(p.id) + ' (' + esc(p.baseUrl || "") + ')</option>').join("")) +
        '</select>' +
        '<span class="hint">Which platform Skyhook should probe for models and load models from.</span>' +
      '</div>' +
      '<h2 class="h-section">Remote control</h2>' +
      '<p><button class="btn ' + ((s.node && s.node.allowRemote) ? "btn-danger" : "btn-primary") + '" id="toggleRemoteBtn" type="button">' +
        ((s.node && s.node.allowRemote) ? "Turn off remote control" : "Turn on remote control (worker)") +
      '</button></p>' +
      '<h2 class="h-section">API endpoint</h2>' +
      '<div class="field">' +
        '<label for="apiBase">Base URL (blank = this origin)</label>' +
        '<input id="apiBase" type="text" value="' + esc(state.apiBase) + '" placeholder="' + esc(window.location.origin) + '" />' +
        '<span class="hint">If you are running the GUI on a different host from the API, set the full URL here.</span>' +
      '</div>' +
      '<h2 class="h-section">Auto-refresh</h2>' +
      '<label class="toggle">' +
        '<input id="live" type="checkbox" />' +
        '<span class="toggle-track"></span>' +
        '<span class="muted">Refresh the dashboard every 10 seconds</span>' +
      '</label>';
    // Wire remote-toggle button (once per render — delegation here is fine since
    // the button is inside the body and we rebind each time).
    body.addEventListener("click", (e) => {
      const t = e.target.closest("#toggleRemoteBtn");
      if (t) toggleRemote(!!(s.node && s.node.allowRemote));
    });
    const apiInput = $("#apiBase");
    if (apiInput) apiInput.addEventListener("change", () => {
      state.apiBase = apiInput.value.trim();
      localStorage.setItem("skyhook.apiBase", state.apiBase);
      $("#apiLabel").textContent = "api → " + apiBase();
      refreshAll();
    });
    const platInput = $("#taggingPlatform");
    if (platInput) {
      platInput.addEventListener("change", async () => {
        const id = platInput.value;
        try {
          await post("/api/settings", { taggingPlatform: id });
          toast("Tagging platform set to " + id + ".", "ok");
        } catch (err) { toast("Save failed: " + err.message, "err"); }
      });
    }
    wireLiveToggle();
  } catch (err) {
    body.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
  }
}

function wireLiveToggle() {
  const liveInput = $("#live");
  if (!liveInput) return;
  liveInput.checked = !!state.live;
  // Restore from localStorage if not already running.
  if (!state.live && localStorage.getItem("skyhook.live") === "1") {
    state.live = setInterval(refreshAll, 10000);
    liveInput.checked = true;
  }
  if (state._liveWired) return;
  state._liveWired = true;
  liveInput.addEventListener("change", () => {
    if (liveInput.checked) {
      state.live = setInterval(refreshAll, 10000);
      localStorage.setItem("skyhook.live", "1");
    } else if (state.live) {
      clearInterval(state.live);
      state.live = null;
      localStorage.setItem("skyhook.live", "0");
    }
  });
}

let logPageState = {
  source: null,
  sources: [],
  active: null,
  pollTimer: null,
  followLog: true,
};

function openLogPage(source) {
  logPageState.source = source;
  const runningSources = state.running.map((r) => r.source);
  const sources = [...new Set([source].concat(runningSources))].filter(Boolean);
  logPageState.sources = sources;
  logPageState.active = source;
  renderLogPageHead();
  renderLogTabs();
  renderLogBody();
  if (source) startLogPagePolling();
  else if (logPageState.pollTimer) { clearInterval(logPageState.pollTimer); logPageState.pollTimer = null; }
}

function closeLogPage() {
  if (logPageState.pollTimer) { clearInterval(logPageState.pollTimer); logPageState.pollTimer = null; }
}

function renderLogPageHead() {
  const s = state.seeders.find((x) => x.source === logPageState.source);
  const running = state.running.find((r) => r.source === logPageState.source);
  $("#logSourceTitle").textContent = logPageState.source
    ? ((s && s.displayName) || logPageState.source)
    : "Live log";
  const meta = [];
  if (s && s.categoryLabel) meta.push(s.categoryLabel + (s.subcategoryLabel ? " · " + s.subcategoryLabel : ""));
  if (s && s.cadence) meta.push(s.cadence);
  if (running) meta.push("running · " + fmtElapsed(running.elapsedMs));
  else if (s && s.lastStatus) meta.push(s.lastStatus);
  $("#logSourceMeta").textContent = logPageState.source
    ? (meta.join(" · ") || "—")
    : "Run a seeder to see its output here.";
  const runBtn = $("#logRunBtn");
  const stopBtn = $("#logStopBtn");
  if (runBtn) runBtn.disabled = !!running || !logPageState.source;
  if (stopBtn) stopBtn.disabled = !running;
}

function renderLogTabs() {
  const container = $("#logTabs");
  if (!container) return;
  const runningSet = new Set(state.running.map((r) => r.source));
  container.innerHTML = logPageState.sources.map((src) => {
    const run = runningSet.has(src);
    const isActive = src === logPageState.active;
    return '<button class="log-tab ' + (isActive ? "active" : "") + ' ' + (run ? "live" : "") + '" data-logtab="' + esc(src) + '" role="tab" aria-selected="' + (isActive ? "true" : "false") + '">' +
      '<span class="spin-pulse" aria-hidden="true"></span>' +
      '<span>' + esc(src) + '</span>' +
    '</button>';
  }).join("");
}

let logRenderSeq = 0;
async function renderLogBody() {
  const seq = ++logRenderSeq;
  const body = $("#logBody");
  if (!body) return;
  if (!logPageState.sources.length) {
    body.innerHTML = '<p class="log-empty">No sources.</p>';
    return;
  }
  const sourcesToShow = [logPageState.active].filter(Boolean);
  const blocks = [];
  for (const src of sourcesToShow) {
    let lines = [];
    try {
      const res = await get("/api/logs/" + encodeURIComponent(src) + "?tail=300");
      lines = res.lines || [];
    } catch (e) { lines = []; }
    const seeder = state.seeders.find((x) => x.source === src);
    blocks.push(
      '<div class="log-block">' +
        '<div class="log-source-head">' + esc(src) + '</div>' +
        (seeder && seeder.description ? '<div class="log-source-desc">' + esc(seeder.description) + '</div>' : "") +
        '<pre class="log-lines">' + (lines.length ? esc(lines.join("\n")) : '<span class="log-empty">(no output yet)</span>') + '</pre>' +
      '</div>');
  }
  if (seq !== logRenderSeq) return;
  const prevScroll = body.scrollTop;
  body.innerHTML = blocks.join("");
  body.scrollTop = logPageState.followLog ? body.scrollHeight : prevScroll;
}

function startLogPagePolling() {
  if (logPageState.pollTimer) return;
  logPageState.pollTimer = setInterval(async () => {
    await loadRunning();
    const runningSources = state.running.map((r) => r.source);
    const newSources = runningSources.filter((s) => logPageState.sources.indexOf(s) === -1);
    if (newSources.length) logPageState.sources = logPageState.sources.concat(newSources);
    renderLogPageHead();
    renderLogTabs();
    await renderLogBody();
  }, 1000);
}

async function runSources(sources, opts) {
  if (!sources.length) return;
  try {
    const res = await post("/api/run", {
      sources,
      parallel: (opts && opts.parallel) || 1,
      withHeadless:   !!(opts && opts.withHeadless),
      aggressive:     !!(opts && opts.aggressive),
      forceHeadless:  !!(opts && opts.forceHeadless),
      noCache:        !!(opts && opts.noCache),
    });
    toast("Started " + ((res.started && res.started.length) || sources.length) + " seeder(s).", "ok");
  } catch (err) { toast("Run failed: " + err.message, "err"); return; }
  await loadRunning();
  if (sources.length === 1) navigate("#/log/" + encodeURIComponent(sources[0]));
  else navigate("#/");
}

async function stopRuns(source) {
  try {
    const res = await post("/api/stop", source ? { source } : {});
    toast(source ? ("Stopped " + source + ".") : ("Stopped " + ((res.stopped && res.stopped.length) || 0) + " run(s)."));
  } catch (err) { toast("Stop failed: " + err.message, "err"); }
  await refreshAll();
}

async function bulkEnable()  { for (const s of state.selected) await post("/api/enable", { source: s, cadence: "weekly" }).catch(() => {}); await refreshAll(); }
async function bulkDisable() { for (const s of state.selected) await post("/api/disable", { source: s }).catch(() => {}); await refreshAll(); }

async function toggleRemote(currentlyOn) {
  try {
    await post("/api/settings", { allowRemote: !currentlyOn });
    toast(currentlyOn ? "Remote control off." : "Remote control on (worker).", "ok");
    renderSettings();
  } catch (err) { toast(err.message, "err"); }
}

let scheduleSource = null;

function openSchedule(source) {
  const s = state.seeders.find((x) => x.source === source);
  if (!s) { toast("Seeder not found.", "err"); return; }
  scheduleSource = source;
  openModal((modal) => {
    modal.classList.add("wide");
    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      '<div class="field"><label for="schedCadence">Cadence</label>' +
        '<select id="schedCadence">' +
          CADENCES.map((c) => '<option value="' + c + '"' + (c === s.cadence ? " selected" : "") + '>' + c + '</option>').join("") +
        '</select>' +
      '</div>' +
      '<div class="field"><label for="schedTier">Tier</label>' +
        '<select id="schedTier">' +
          '<option value="evergreen"' + (!s.isNews ? " selected" : "") + '>evergreen</option>' +
          '<option value="news"' + (s.isNews ? " selected" : "") + '>news (age-pruned)</option>' +
        '</select>' +
      '</div>' +
      '<div class="field"><label for="schedAge">Max age (days, 0 = none)</label>' +
        '<input id="schedAge" type="number" min="0" value="' + (s.maxAgeDays || 0) + '" />' +
      '</div>' +
      '<p class="muted">' + esc(s.source) + ' — ' + esc(s.displayName || "") + '</p>';
    const cancel = mkBtn("Cancel", "btn");
    const save = mkBtn("Save", "btn-primary");
    cancel.addEventListener("click", closeModal);
    save.addEventListener("click", saveSchedule);
    modalShell(modal, { title: "Schedule — " + s.source, body, actions: [cancel, save] });
  });
}


function mkBtn(label, cls) {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  return b;
}

function openBuildModal() {
  openModal((modal) => {
    modal.classList.add("wide");
    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      '<div class="field"><label for="buildUrl">Website URL</label>' +
        '<input id="buildUrl" type="url" placeholder="https://example.com" />' +
        '<span id="buildPreview" class="hint"></span>' +
      '</div>' +
      '<div class="field" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">' +
        '<div><label for="buildName">Display name</label><input id="buildName" type="text" placeholder="Example Site" /></div>' +
        '<div><label for="buildSource">Source (unique slug)</label><input id="buildSource" type="text" placeholder="example" /></div>' +
      '</div>' +
      '<div class="field" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">' +
        '<div><label for="buildCategory">Category</label><select id="buildCategory"></select></div>' +
        '<div><label for="buildSubcategory">Subcategory</label><select id="buildSubcategory"></select></div>' +
      '</div>' +
      '<div class="field"><label for="buildFeed">Feed URL (optional — auto-discovered if blank)</label>' +
        '<input id="buildFeed" type="url" placeholder="https://example.com/feed/" /></div>' +
      '<div class="field"><label for="buildCadence">Cadence</label><select id="buildCadence"></select></div>';
    const cancel = mkBtn("Cancel", "btn");
    const save = mkBtn("Save", "btn-primary");
    const test = mkBtn("Save & test", "btn-primary");
    cancel.addEventListener("click", closeModal);
    save.addEventListener("click", async () => {
      const src = await submitBuild(false);
      if (src) closeModal();
    });
    test.addEventListener("click", async () => {
      const src = await submitBuild(true);
      if (src) closeModal();
    });
    modalShell(modal, { title: "New seeder", body, actions: [cancel, save, test] });
    setTimeout(() => {
      fillBuildCategory();
      $("#buildCategory").addEventListener("change", () => fillBuildSubcategory(""));
      $("#buildUrl").addEventListener("blur", debounce(previewUrl, 500));
    }, 0);
  });
}

function fillBuildCategory() {
  const sel = $("#buildCategory");
  if (!sel) return;
  sel.innerHTML = (state.categories || []).map((c) =>
    '<option value="' + esc(c.name) + '">' + esc(c.label) + '</option>').join("");
  fillBuildSubcategory("");
}

function fillBuildSubcategory(preserve) {
  const catName = $("#buildCategory").value;
  const cat = (state.categories || []).find((c) => c.name === catName);
  const sel = $("#buildSubcategory");
  if (!sel) return;
  sel.innerHTML = (cat && cat.subcategories ? cat.subcategories : []).map((s) =>
    '<option value="' + esc(s.name) + '">' + esc(s.label) + '</option>').join("");
  if (preserve && [...sel.options].some((o) => o.value === preserve)) sel.value = preserve;
  const cad = $("#buildCadence");
  if (cad) cad.innerHTML = CADENCES.map((c) =>
    '<option value="' + c + '"' + (c === "manual" ? " selected" : "") + '>' + c + '</option>').join("");
}

async function previewUrl() {
  const url = $("#buildUrl").value.trim();
  if (!/^https?:\/\//i.test(url)) { $("#buildPreview").textContent = ""; return; }
  $("#buildPreview").textContent = "Fetching site metadata…";
  try {
    const meta = await post("/api/seeders/preview", { url });
    if (!$("#buildName").value)   $("#buildName").value   = meta.title || meta.siteName || meta.siteDomain || "";
    if (!$("#buildSource").value) $("#buildSource").value = meta.source || "";
    $("#buildPreview").textContent = meta.title ? ("✓ " + meta.title) : "✓ fetched";
  } catch (err) { $("#buildPreview").textContent = "⚠ " + err.message; }
}

async function submitBuild(runAfter) {
  const url = $("#buildUrl").value.trim();
  if (!url) { toast("Enter a website URL.", "err"); return null; }
  const category = $("#buildCategory").value;
  const subcategory = $("#buildSubcategory").value;
  if (!category || !subcategory) { toast("Pick a category and subcategory.", "err"); return null; }
  try {
    const res = await post("/api/seeders/new", {
      url,
      displayName: $("#buildName").value.trim(),
      source: $("#buildSource").value.trim(),
      category,
      subcategory,
      feedUrl: $("#buildFeed").value.trim(),
      cadence: $("#buildCadence").value,
    });
    toast("Created \"" + ((res.seeder && res.seeder.source) || res.source) + "\".", "ok");
    await refreshAll();
    const src = (res.seeder && res.seeder.source) || res.source;
    if (runAfter && src) await runSources([src]);
    return src;
  } catch (err) {
    toast("Create failed: " + err.message, "err");
    return null;
  }
}

async function saveSchedule() {
  if (!scheduleSource) return;
  const cadence = $("#schedCadence").value;
  const tier = $("#schedTier").value;
  const maxAge = parseInt($("#schedAge").value, 10) || 0;
  try {
    await post("/api/schedule", {
      source: scheduleSource,
      cadence,
      isNews: tier === "news",
      maxAgeDays: maxAge || null,
    });
    toast("Updated " + scheduleSource + ".", "ok");
    closeModal();
    await refreshAll();
  } catch (err) { toast("Schedule failed: " + err.message, "err"); }
}

function openApiBasePrompt() {
  const inp = prompt("API base URL (blank = this origin):", state.apiBase);
  if (inp == null) return;
  state.apiBase = inp.trim();
  localStorage.setItem("skyhook.apiBase", state.apiBase);
  $("#apiLabel").textContent = "api → " + apiBase();
  refreshAll();
}

let offlineFails = 0;
async function refreshAll() {
  try {
    await Promise.all([loadSeeders(), loadRunning(), loadPipeline(), loadSettings()]);
    offlineFails = 0;
    $("#apiLabel").textContent = "api → " + apiBase();
    $("#apiLabel").classList.remove("offline");
    // Don't re-render the Settings panel during auto-refresh — it tears down
    // the live toggle and resets the checkbox state.
    if (state.route.name !== "settings") handleRouteChange();
  } catch (err) {
    offlineFails++;
    $("#apiLabel").textContent = "offline — " + err.message;
    $("#apiLabel").classList.add("offline");
    if (offlineFails === 3) toast("Cannot reach API: " + err.message, "err");
  }
}


// ─── event wiring (delegation) ─────────────────────────────────────────

function bind() {
  $("#refreshBtn").addEventListener("click", () => refreshAll());
  $("#apiBaseBtn").addEventListener("click", openApiBasePrompt);

  const filterEl = $("#filter");
  if (filterEl) filterEl.addEventListener("input", debounce(renderSeeders, 80));
  const tierEl = $("#tierFilter");
  if (tierEl) tierEl.addEventListener("change", renderSeeders);
  const schedEl = $("#schedFilter");
  if (schedEl) schedEl.addEventListener("change", renderSeeders);
  const statusEl = $("#statusFilter");
  if (statusEl) statusEl.addEventListener("change", renderSeeders);

  $$("#seederTable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = 1; }
      // Update sort-direction indicator arrows.
      $$("#seederTable th[data-sort]").forEach((h) => {
        h.classList.remove("sort-asc", "sort-desc");
        if (h.dataset.sort === state.sortKey) {
          h.classList.add(state.sortDir > 0 ? "sort-asc" : "sort-desc");
        }
      });
      renderSeeders();
    }));

  const checkAll = $("#checkAll");
  if (checkAll) checkAll.addEventListener("change", () => {
    const on = checkAll.checked;
    filtered().forEach((s) => { on ? state.selected.add(s.source) : state.selected.delete(s.source); });
    renderSeeders();
  });

  for (const sel of ["#seederBody", "#seederCards"]) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const src = cb.dataset.source;
      cb.checked ? state.selected.add(src) : state.selected.delete(src);
      updateBulkBar();
    });
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const source = btn.dataset.source;
      if (action === "run") runSources([source]);
      else if (action === "schedule") openSchedule(source);
      else if (action === "toggle") {
        const s = state.seeders.find((x) => x.source === source);
        const p = s && s.scheduled
          ? post("/api/disable", { source }).then(() => toast("Disabled " + source + "."))
          : post("/api/enable", { source, cadence: "weekly" }).then(() => toast("Enabled " + source + " (weekly)."));
        p.then(refreshAll);
      }
    });
  }

  const runSel = $("#runSelectedBtn");
  if (runSel) runSel.addEventListener("click", () => runSources([...state.selected]));
  const be = $("#bulkEnableBtn");
  if (be) be.addEventListener("click", bulkEnable);
  const bd = $("#bulkDisableBtn");
  if (bd) bd.addEventListener("click", bulkDisable);
  const ns = $("#newSeederBtn");
  if (ns) ns.addEventListener("click", openBuildModal);
  const rd = $("#runDueBtn");
  if (rd) rd.addEventListener("click", () => {
    const sources = ($("#forceDue") && $("#forceDue").checked
      ? state.seeders.filter((s) => s.scheduled)
      : state.seeders.filter(isDueClient)).map((s) => s.source);
    runSources(sources);
  });
  const et = $("#emitTimerBtn");
  if (et) et.addEventListener("click", writeTimer);

  const due = $("#dueList");
  if (due) due.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="run"]');
    if (btn) runSources([btn.dataset.source]);
  });
  const fl = $("#failList");
  if (fl) fl.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="run"]');
    if (btn) runSources([btn.dataset.source]);
  });
  const rl = $("#runningList");
  if (rl) rl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-stop-one]");
    if (btn) stopRuns(btn.dataset.stopOne);
  });

  const pc = $("#pipelineCards");
  if (pc) pc.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pipe]");
    if (!btn) return;
    if (btn.dataset.danger === "1" && !confirm('Run "' + btn.dataset.pipe + '"? This is destructive and cannot be undone.')) return;
    startPipeline(btn.dataset.pipe);
  });

  const rtb = $("#runTaskBtn");
  if (rtb) rtb.addEventListener("click", runTask);
  const tt = $("#tagTask");
  if (tt) tt.addEventListener("change", syncTagMinTags);
  const lmb = $("#loadModelBtn");
  if (lmb) lmb.addEventListener("click", loadSelectedModel);

  const pb = $("#pruneBtn");
  if (pb) pb.addEventListener("click", async () => {
    try {
      const filter = {};
      const src = $("#curateSource") && $("#curateSource").value.trim();
      const before = $("#curateBefore") && $("#curateBefore").value;
      if (src) filter.source = src;
      if (before) filter.before = before;
      const r = await post("/api/cache/prune", { filter });
      toast("Deleted " + r.deleted + " URL(s) (kept " + r.kept + ").", "ok");
      renderCuration();
    } catch (err) { toast(err.message, "err"); }
  });
  const cr = $("#curateRefreshBtn");
  if (cr) cr.addEventListener("click", renderCuration);
  const cb = $("#curationBody");
  if (cb) cb.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const source = btn.dataset.source;
    try {
      if (action === "clear-staged") {
        await post("/api/cache/clear", { source });
        toast("Cleared staged for " + source + ".", "ok");
      } else if (action === "clear-discovery") {
        await post("/api/cache/clear", { source, kind: "discovery" });
        toast("Cleared discovery cache for " + source + ".", "ok");
      }
      renderCuration();
    } catch (err) { toast(err.message, "err"); }
  });

  const lb = $("#logBackBtn");
  if (lb) lb.addEventListener("click", () => navigate("#/seeders"));
  const lr = $("#logRunBtn");
  if (lr) lr.addEventListener("click", () => logPageState.source && runSources([logPageState.source]));
  const ls = $("#logStopBtn");
  if (ls) ls.addEventListener("click", () => logPageState.source && stopRuns(logPageState.source));
  const lsc = $("#logScheduleBtn");
  if (lsc) lsc.addEventListener("click", () => logPageState.source && openSchedule(logPageState.source));
  const lt = $("#logTabs");
  if (lt) lt.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-logtab]");
    if (!tab) return;
    logPageState.active = tab.dataset.logtab;
    logPageState.followLog = true;
    $$("#logTabs .log-tab").forEach((b) => b.classList.toggle("active", b.dataset.logtab === logPageState.active));
    renderLogBody();
  });
  const lb2 = $("#logBody");
  if (lb2) lb2.addEventListener("scroll", () => {
    const b = $("#logBody");
    logPageState.followLog = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  });

  const wt = $("#writeTimerBtn");
  if (wt) wt.addEventListener("click", writeTimer);

  const fs = $("#filterSheetBtn");
  if (fs) fs.addEventListener("click", () => {
    openModal((modal) => {
      const body = document.createElement("div");
      body.className = "modal-body";
      body.innerHTML =
        '<div class="field"><label for="modalTier">Tier</label>' +
          '<select id="modalTier"><option value="">All tiers</option><option value="news">News</option><option value="evergreen">Evergreen</option></select>' +
        '</div>' +
        '<div class="field"><label for="modalSched">Schedule</label>' +
          '<select id="modalSched"><option value="">Scheduled + manual</option><option value="1">Scheduled only</option><option value="0">Manual only</option></select>' +
        '</div>' +
        '<div class="field"><label for="modalStatus">Status</label>' +
          '<select id="modalStatus"><option value="">Any status</option><option value="due">Due</option><option value="errors">Errors</option></select>' +
        '</div>';
      const apply = mkBtn("Apply", "btn-primary");
      apply.addEventListener("click", () => {
        $("#tierFilter").value = $("#modalTier").value;
        $("#schedFilter").value = $("#modalSched").value;
        $("#statusFilter").value = $("#modalStatus").value;
        closeModal();
        renderSeeders();
      });
      modalShell(modal, { title: "More filters", body, actions: [apply] });
    });
  });

  // Keyboard shortcuts (skip when typing in a form).
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "/") { e.preventDefault(); if ($("#filter")) $("#filter").focus(); }
    else if (e.key === "r" && !e.metaKey && !e.ctrlKey) refreshAll();
    else if (e.key === "g") {
      const once = (e2) => {
        document.removeEventListener("keydown", once);
        if (e2.key === "d") navigate("#/");
        else if (e2.key === "s") navigate("#/seeders");
        else if (e2.key === "p") navigate("#/pipeline");
        else if (e2.key === "c") navigate("#/curation");
      };
      document.addEventListener("keydown", once, { once: true });
      setTimeout(() => document.removeEventListener("keydown", once), 1000);
    }
  });

  window.addEventListener("hashchange", handleRouteChange);
}

async function startPipeline(kind) {
  let jobKey = null;
  try {
    const res = await post("/api/pipeline/" + kind);
    jobKey = res.job;
    toast("Started " + jobKey + ".", "ok");
  } catch (err) { toast(err.message, "err"); return; }
  await loadRunning();
  if (jobKey && state.running.some((r) => r.source === jobKey)) {
    navigate("#/log/" + encodeURIComponent(jobKey));
  } else {
    await loadPipeline();
    handleRouteChange();
  }
}

async function writeTimer() {
  try {
    const t = await post("/api/timer", {});
    toast("Timer regenerated: " + (t.onCalendar || "none"), "ok");
    await renderTimer();
  } catch (err) { toast("Timer failed: " + err.message, "err"); }
}

async function init() {
  $("#apiLabel").textContent = "api: " + apiBase();
  bind();
  // Restore auto-refresh from localStorage if it was on.
  if (localStorage.getItem("skyhook.live") === "1" && !state.live) {
    state.live = setInterval(refreshAll, 10000);
  }
  await loadCategories();
  await refreshAll();
  handleRouteChange();
}

init().catch((err) => {
  console.error("init failed:", err);
  document.body.innerHTML =
    '<div style="padding:32px;color:#ff5c5c;font-family:monospace;">' +
      '<h1>Skyhook GUI failed to start</h1>' +
      '<pre>' + esc(err.message) + '\n' + esc(err.stack || "") + '</pre>' +
      '<p>Check the browser dev tools console for details.</p>' +
    '</div>';
});
