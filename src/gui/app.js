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

const EMPTY_FILTERS = { tier: "", sched: "", status: "", category: null, subcategory: null };

const state = {
  seeders: [], running: [], batch: null, pipe: null, cache: null,
  sortKey: "source", sortDir: 1, selected: new Set(),
  apiBase: localStorage.getItem("skyhook.apiBase") || "",
  live: null, _liveWired: false, logSources: [], followLog: true, userTab: null,
  historySource: null, wasRunning: false, categories: [],
  infoSource: null, taggingGaps: null, tagTasks: [],
  // W5: the status bar's "synced" is this console's last successful poll, and the dock's
  // open/closed state lives on `#workbench[data-dock]` — this is the only copy of the former.
  lastRefreshAt: 0,
  // W3: what the inspector shows. Client state, not a route — a reload forgets the pick.
  focus: null, inspRuns: null, inspStaged: null, inspRunAt: null, inspSeq: 0,
  // W4: the tier/schedule/status selects live in the filter sheet now, so their values are state
  // rather than DOM, and the navigator tree writes `category`/`subcategory`. Not persisted on
  // purpose: a reload that forgets a filter it can no longer show is the safer default.
  filters: { ...EMPTY_FILTERS },
  route: { name: "dashboard", params: {} },
  nodeId: "local",
};

/* The desktop shell injects a flag before any page script runs
 * (`src-tauri/src/main.rs`, DC7), and a browser has none. It is the only desktop
 * signal on purpose: a user-agent string is a guess about the host, while this is
 * the shell stating it. */
const isDesktop = () => Boolean(window.__SKYHOOK_DESKTOP__);

const REQUEST_TIMEOUT_MS = 15000;

const apiBase = () => {
  // A window has exactly one server — the one the shell spawned — so an override a
  // browser session left in localStorage must not redirect it.
  if (isDesktop()) return window.location.origin;
  const override = state.apiBase.trim();
  if (override) {
    // A loop, because `/\/+$/` backtracks quadratically — the shape `src/core/remote.js:66-70` uses.
    let base = override;
    while (base.endsWith("/")) base = base.slice(0, -1);
    return base;
  }
  return window.location.origin;
};

/* The per-launch bearer token the shell also injects, so `api()` can answer a
 * mutating route. With no flag the renderer's requests are unchanged. */
const desktopToken = () => window.__SKYHOOK_DESKTOP__?.token || null;

async function api(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    const token = desktopToken();
    if (token && method === "POST") headers.Authorization = `Bearer ${token}`;
    const res = await fetch(apiBase() + path, {
      method, signal: ctrl.signal,
      headers: Object.keys(headers).length ? headers : undefined,
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
const resultText = (r) => (r ? ("+" + (r.staged ?? 0) + " −" + (r.dead ?? 0)) : "");
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
/**
 * What this console may start: due by cadence, and not already in flight.
 *
 * The server applies both halves (`/api/due` excludes a run in flight, #31) and the console mirrors
 * them because its list is rebuilt from `/api/seeders`, not from `/api/due`. A row that is running
 * stays visible in the running panel; offering it a Run button only produces `skippedRunning`.
 */
function dueNowClient() {
  const live = new Set((state.running || []).map((r) => r.source));
  return state.seeders.filter((s) => isDueClient(s) && !live.has(s.source));
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

// The pane head is the section's title bar, so one map is the whole naming rule.
const ROUTE_TITLES = {
  dashboard: "Dashboard", seeders: "Seeders", pipeline: "Pipeline",
  stats: "Stats", curation: "Curation", timer: "Timer", settings: "Settings",
};
function applyNodeVisibility() {
  const show = isPiNode();
  $$("[data-pi-only]").forEach((el) => { el.style.display = show ? "" : "none"; });
  if (!show && state.route.name === "timer") navigate("#/");
}
function handleRouteChange() {
  const r = parseRoute();
  // W5: `#/log/:source` is a dock deep link on the desktop, not a section — the work surface keeps
  // what it was already showing and the rail keeps its place. At 720 px and below there is no dock
  // at all (`styles.css` hides it), so the route stays a surface there, exactly as before.
  const deepLink = r.name === "log" && !isPhone();
  // A pick belongs to the section that offered it: a row chosen in Seeders must not sit behind
  // the Pipeline's back. The log dock is what survives a section change (W5), not the inspector.
  // A palette closed here has done its job or lost its route — a poll calls this function too, so
  // closing unconditionally would shut the palette mid-keystroke.
  if (r.name !== state.route.name && !deepLink) {
    clearFocus();
    closePalette();
  }
  if (!deepLink) state.route = r;
  const route = state.route;
  $$(".surface").forEach((p) => p.classList.toggle("active", p.dataset.route === route.name));
  $$(".rail-item, .navlist-item, .bn-item").forEach((el) => el.classList.toggle("active", el.dataset.route === route.name));
  renderNav();
  renderInspector();
  // The pane head names the section; a log route names its source instead.
  const workTitle = $("#workTitle");
  if (workTitle) workTitle.textContent = route.name === "log" ? (r.params.source || "log") : ROUTE_TITLES[route.name] || route.name;
  if (route.name === "timer" && !isPiNode()) { navigate("#/"); return; }
  if (route.name === "dashboard") renderDashboard();
  if (route.name === "seeders") renderSeeders();
  if (route.name === "pipeline") renderPipeline();
  if (route.name === "stats") renderAnalytics();
  if (route.name === "curation") renderCuration();
  if (route.name === "settings") renderSettings();
  if (route.name === "timer") renderTimer();
  if (r.name === "log") {
    // If no specific source, fall back to the first running seeder (or the
    // most recent log source) so the mobile "Logs" nav item always lands.
    const src = r.params.source || (state.running[0] && state.running[0].source) || logPageState.source;
    // Only a source the route has not asked for yet reopens it: `refreshAll` runs this on every
    // poll, and a tab the user picked must survive the poll that follows it.
    if (src !== logPageState.routeSource) openLogPage(src);
    // Repainting an already-open dock would fetch its tail a second time per tick.
    if (deepLink && $("#workbench").dataset.dock !== "open") setDockOpen(true);
  }
  syncLogPolling();
  renderStatus();
}

async function loadSeeders()    { state.seeders = await get("/api/seeders?limit=5000"); }
async function loadRunning()    { const r = await get("/api/running").catch(() => ({ running: [] })); state.running = r.running || []; state.batch = r.batch || null; }
async function loadPipeline()   { state.pipe = await get("/api/pipeline").catch(() => null); }

/* One predicate for the table and the navigator. `over` lets the tree ask "how many rows would
 * this node leave?" without touching the live filter: an omitted key falls back to state.filters,
 * an explicit value (including "" / null) replaces it. */
function matchesFilters(s, over = {}) {
  const input = $("#filter");
  const f = (over.text !== undefined ? over.text : (input ? input.value : "")).trim().toLowerCase();
  const tier = over.tier !== undefined ? over.tier : state.filters.tier;
  const sched = over.sched !== undefined ? over.sched : state.filters.sched;
  const status = over.status !== undefined ? over.status : state.filters.status;
  const category = over.category !== undefined ? over.category : state.filters.category;
  const subcategory = over.subcategory !== undefined ? over.subcategory : state.filters.subcategory;
  if (f) {
    const hit =
      (s.source || "").toLowerCase().includes(f) ||
      (s.script || "").toLowerCase().includes(f) ||
      (s.displayName || "").toLowerCase().includes(f) ||
      (s.categoryLabel || "").toLowerCase().includes(f) ||
      (s.subcategoryLabel || "").toLowerCase().includes(f);
    if (!hit) return false;
  }
  if (tier === "news" && !s.isNews) return false;
  if (tier === "evergreen" && s.isNews) return false;
  if (sched === "1" && !s.scheduled) return false;
  if (sched === "0" && s.scheduled) return false;
  if (status === "due" && !isDueClient(s)) return false;
  if (status === "errors" && !isErrorStatus(s)) return false;
  // `null` is "no filter", "" is a real bucket (a seeder filed under no category), so the two
  // cannot share a falsy test.
  if (category !== null && (s.category || "") !== category) return false;
  if (subcategory !== null && (s.subcategory || "") !== subcategory) return false;
  return true;
}
function filtered() { return state.seeders.filter((s) => matchesFilters(s)); }
const countWith = (over) => state.seeders.filter((s) => matchesFilters(s, over)).length;
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
  const tbody = $("#seederBody");
  tbody.innerHTML = "";
  // Roving tabindex: one tab stop for the whole table, arrows inside it (see wireRowFocus).
  const roveSource = rowFocusSource || (rows[0] && rows[0].source);
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.dataset.source = s.source;
    tr.tabIndex = s.source === roveSource ? 0 : -1;
    if (s.source === state.focus) {
      tr.classList.add("focused");
      tr.setAttribute("aria-current", "true");
    }
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
        '<div class="seeder-card' + (isRunning ? " running" : "") + (s.source === state.focus ? " focused" : "") + '" data-source="' + esc(s.source) + '">' +
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
  renderNav();
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

/* ── navigator (W4) ──────────────────────────────────────────────────────
 * The pane holds the current section's own outline, not a second copy of the section list: the
 * rail switches sections, this says what is inside the one you are on. Every node is a <button>,
 * an <a>, or a non-clickable row — never a clickable <div>.
 *
 * What is expanded is *derived*, not stored: no pick renders the pillars, a picked pillar renders
 * its subcategories, a picked subcategory renders its seeders. The 10/30 s poll repaints this pane,
 * so a stored open/closed flag would collapse under the user's hands mid-click. */
const NAV_TITLES = { dashboard: "Due now", seeders: "Categories", pipeline: "Jobs", curation: "Sources" };

const humanLabel = (n) =>
  String(n || "uncategorised").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dotFor = (s) => "dot" + (s.lastStatus === "ok" ? " ok" : s.lastStatus ? " err" : "");

function navRow({ label, count, attrs = "", title = "", pressed = null, indent = false, leaf = false, dot = "", current = false }) {
  const cls = "nav-node" + (indent ? " sub" : "") + (leaf ? " leaf" : "") + (pressed ? " on" : "");
  return '<button type="button" class="' + cls + '" ' + attrs +
    (title ? ' title="' + esc(title) + '"' : "") +
    // A toggle says its state even when it is off: a bare button that sometimes has aria-pressed
    // reads as "not a toggle" half the time.
    (pressed === null ? "" : ' aria-pressed="' + (pressed ? "true" : "false") + '"') +
    (current ? ' aria-current="true"' : "") + ">" +
    (dot ? '<span class="' + dot + '" aria-hidden="true"></span>' : "") +
    '<span class="nav-label">' + esc(label) + "</span>" +
    (count == null ? "" : '<span class="nav-count">' + count + "</span>") +
    "</button>";
}

const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/* The tree is built from the rows the table already holds, so its counts and its leaves can never
 * disagree with the table; `state.categories` only lends nicer labels where a seeder has none. */
function seederTree() {
  const cats = new Map();
  for (const s of state.seeders) {
    const cat = s.category || "";
    if (!cats.has(cat)) cats.set(cat, { name: cat, label: s.categoryLabel || humanLabel(cat), subs: new Map() });
    const node = cats.get(cat);
    const sub = s.subcategory || "";
    if (!node.subs.has(sub)) node.subs.set(sub, { name: sub, label: s.subcategoryLabel || humanLabel(sub), rows: [] });
    node.subs.get(sub).rows.push(s);
  }
  return [...cats.values()].sort(byLabel);
}

function renderNav() {
  const tree = $("#navTree");
  const list = $("#navList");
  if (!tree || !list) return;
  const route = state.route.name;
  const title = $("#navTitle");
  if (title) title.textContent = NAV_TITLES[route] || "Sections";
  renderFilterChips();
  const html =
    route === "seeders" ? navSeeders() :
    route === "curation" ? navCuration() :
    route === "pipeline" ? navPipeline() :
    route === "dashboard" ? navDue() : "";
  tree.innerHTML = html;
  // A section with an outline hides the flat list — the rail is the section switcher — and a
  // section without one keeps it, so the pane is never empty.
  tree.hidden = !html;
  list.hidden = Boolean(html);
}

function navSeeders() {
  const f = state.filters;
  const quick = [
    { key: "all", label: "All seeders", over: { tier: "", status: "" }, on: !f.tier && !f.status },
    { key: "due", label: "Due now", over: { status: "due" }, on: f.status === "due" },
    { key: "errors", label: "Errors", over: { status: "errors" }, on: f.status === "errors" },
    { key: "news", label: "News tier", over: { tier: "news" }, on: f.tier === "news" },
    { key: "evergreen", label: "Evergreen tier", over: { tier: "evergreen" }, on: f.tier === "evergreen" },
  ];
  let html = '<div class="nav-group">Filter</div>' + quick.map((q) =>
    navRow({ label: q.label, count: countWith(q.over), attrs: 'data-nav-quick="' + q.key + '"', pressed: q.on })).join("");

  html += '<div class="nav-group">Categories</div>';
  const pillars = seederTree();
  if (!pillars.length) return html + '<p class="nav-empty">No seeders yet.</p>';
  for (const p of pillars) {
    const n = countWith({ category: p.name, subcategory: null });
    if (!n && p.name !== f.category) continue;          // a pillar with nothing in it is noise
    html += navRow({
      label: p.label, count: n, title: p.label,
      attrs: 'data-nav-cat="' + esc(p.name) + '"', pressed: f.category === p.name,
    });
    if (p.name !== f.category) continue;
    for (const sub of [...p.subs.values()].sort(byLabel)) {
      const sn = countWith({ category: p.name, subcategory: sub.name });
      if (!sn) continue;
      html += navRow({
        label: sub.label, count: sn, indent: true,
        attrs: 'data-nav-sub="' + esc(sub.name) + '"', pressed: f.subcategory === sub.name,
      });
      if (f.subcategory !== sub.name) continue;
      // Leaves are the rows the table is actually showing for this node — the tier/status/text
      // filters still apply, so a leaf never names a row the table has hidden.
      const leaves = sub.rows
        .filter((s) => matchesFilters(s, { category: p.name, subcategory: sub.name }))
        .sort((a, b) => a.source.localeCompare(b.source));
      for (const s of leaves) {
        html += navRow({
          label: s.source, leaf: true, dot: dotFor(s), current: s.source === state.focus,
          attrs: 'data-nav-pick="' + esc(s.source) + '"',
        });
      }
    }
  }
  return html;
}

function navCuration() {
  const staged = state.cache && Array.isArray(state.cache.staged) ? state.cache.staged : [];
  if (!staged.length) return "";
  const rows = staged.reduce((n, f) => n + (Number(f.count) || 0), 0);
  return '<div class="nav-group">Staged · ' + rows.toLocaleString() + " rows</div>" +
    staged.map((f) => {
      const source = f.originalSource || f.source;
      return navRow({
        label: source, count: Number(f.count) || 0,
        attrs: 'data-nav-curate="' + esc(source) + '"', title: "Jump to " + source,
      });
    }).join("");
}

function navPipeline() {
  const jobs = state.pipe && Array.isArray(state.pipe.jobs) ? state.pipe.jobs : [];
  if (!jobs.length) return "";
  return '<div class="nav-group">Jobs</div>' + jobs.map((j) => navRow({
    label: j.label || j.key || "job",
    dot: "dot" + (j.status === "running" ? " live" : j.status === "ok" ? " ok" : j.status ? " err" : ""),
    attrs: 'data-nav-job="' + esc(j.key || j.label || "") + '"', title: "Jump to this job",
  })).join("");
}

function navDue() {
  const due = dueNowClient()
    .sort((a, b) => String(a.nextRunAt || "").localeCompare(String(b.nextRunAt || "")));
  if (!due.length) return '<div class="nav-group">Due now</div><p class="nav-empty">Nothing due.</p>';
  return '<div class="nav-group">Due now · ' + due.length + "</div>" +
    due.slice(0, 20).map((s) =>
      '<a class="nav-node" href="#/log/' + encodeURIComponent(s.source) + '" title="Open the log">' +
        '<span class="nav-label">' + esc(s.source) + "</span>" +
        '<span class="nav-count">' + esc(fmtIn(s.nextRunAt)) + "</span></a>").join("") +
    (due.length > 20 ? '<p class="nav-empty">+' + (due.length - 20) + " more</p>" : "");
}

/* A filter the toolbar no longer shows still has to be visible somewhere, or it is a trap: the
 * chips are both the record and the way off. */
const FILTER_KEYS = ["tier", "sched", "status", "category", "subcategory"];
/* tier/sched/status are "off" at "", while category/subcategory are "off" at null — an empty
 * string is the bucket a seeder with no category lands in. */
const isNavKey = (k) => k === "category" || k === "subcategory";
const filterOn = (k) => (isNavKey(k) ? state.filters[k] !== null : Boolean(state.filters[k]));
const chipValue = (k, v) => {
  if (k === "sched") return v === "1" ? "scheduled" : "manual";
  if (isNavKey(k)) return v === "" ? "uncategorised" : v;
  return v;
};

function renderFilterChips() {
  const el = $("#activeFilters");
  if (!el) return;
  const chips = state.route.name === "seeders"
    ? FILTER_KEYS.filter(filterOn).map((k) =>
        '<button type="button" class="filter-chip" data-clearfilter="' + k + '" aria-label="Remove the ' + k + ' filter">' +
          esc(k + ": " + chipValue(k, state.filters[k])) + '<span aria-hidden="true"> ×</span></button>')
    : [];
  el.innerHTML = chips.join("");
  el.hidden = chips.length === 0;
}

function setQuick(key) {
  const f = state.filters;
  if (key === "all") { f.tier = ""; f.status = ""; }
  else if (key === "due" || key === "errors") f.status = f.status === key ? "" : key;
  else f.tier = f.tier === key ? "" : key;
  renderSeeders();
}

function toggleNav(key, value) {
  const f = state.filters;
  if (f[key] === value) f[key] = null;
  else { f[key] = value; if (key === "category") f.subcategory = null; }
  renderSeeders();
}

function clearFilter(key) {
  state.filters[key] = key === "category" || key === "subcategory" ? null : "";
  if (key === "category") state.filters.subcategory = null;
  renderSeeders();
}

/* A navigator row for a list that is already on screen: bring it into view and let the work
 * surface say "this one" for a moment. No new route and no new fetch. */
function scrollToRow(containerId, attr, value) {
  const root = document.getElementById(containerId);
  if (!root) return;
  const row = [...root.querySelectorAll("[" + attr + "]")].find((el) => el.getAttribute(attr) === value);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1200);
}

function renderDashboard() {
  const total = state.seeders.length;
  const scheduled = state.seeders.filter((s) => s.scheduled).length;
  const due = dueNowClient().length;
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
    if (t === "scheduled") state.filters.sched = "1";
    else if (t === "due") state.filters.status = "due";
    else if (t === "errors") state.filters.status = "errors";
    else { state.filters.sched = ""; state.filters.status = ""; }
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
    runningEl.innerHTML = '<p class="empty">Nothing running.</p>';
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
    failEl.innerHTML = '<p class="empty">No failures. ✓</p>';
  }

  const dueNow = dueNowClient();
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
    dueEl.innerHTML = '<p class="empty">Nothing due right now.</p>';
  }

  renderBatchProgress();
  renderNav();
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
          '<div class="job-row" data-job="' + esc(j.key || j.label || "") + '">' +
            '<span class="job-status ' + esc(j.status || "idle") + '"></span>' +
            '<span>' + esc(j.label || j.key) + '</span>' +
          '</div>').join("")
      : '<p class="muted">No pipeline jobs.</p>';
  }
  await loadTaggingGaps();
  if (state.taggingGaps) $("#taggingGaps").innerHTML = gapCards(state.taggingGaps);
  renderPipelineStatus(p);
  await renderTaggingTasks();
  renderNav();
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
    state.cache = c;
    const stageRows = (c.staged || []).reduce((n, f) => n + f.count, 0);
    const body = $("#curationBody");

    const stagedSection = (c.staged || []).length
      ? '<div class="curate-section">' +
          '<h2 class="h-section">Staged (' + c.staged.length + ' sources, ' + stageRows.toLocaleString() + ' rows)</h2>' +
          (c.staged || []).map((f) =>
            '<div class="curate-row" data-curation-source="' + esc(f.originalSource || f.source) + '">' +
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
    renderNav();
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
    // A window has no use for this field and no way to honour it (`apiBase`).
    const apiEndpoint = isDesktop()
      ? ""
      : '<h2 class="h-section">API endpoint</h2>' +
        '<div class="field">' +
          '<label for="apiBase">Base URL (blank = this origin)</label>' +
          '<input id="apiBase" type="text" value="' + esc(state.apiBase) + '" placeholder="' + esc(window.location.origin) + '" />' +
          '<span class="hint">If you are running the GUI on a different host from the API, set the full URL here.</span>' +
        '</div>';
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
      '<p><button class="btn ' + ((s.node && s.node.allowRemote) ? "btn-danger" : "btn-primary") + '" id="toggleRemoteBtn" type="button" data-remote-on="' + ((s.node && s.node.allowRemote) ? "1" : "0") + '">' +
        ((s.node && s.node.allowRemote) ? "Turn off remote control" : "Turn on remote control (worker)") +
      '</button></p>' +
      apiEndpoint +
      '<h2 class="h-section">Auto-refresh</h2>' +
      '<label class="toggle">' +
        '<input id="live" type="checkbox" />' +
        '<span class="toggle-track"></span>' +
        '<span class="muted">Refresh the dashboard: 10 s while a run is active, 30 s when idle</span>' +
      '</label>';
    // The remote toggle is delegated in `bind()`, not bound here: `#settingsBody` is a static node
    // whose children are repainted on every visit and after every toggle, so a listener added in
    // this function accumulated one copy per visit — several POSTs from one click, each with the
    // state its own render saw (#40). The button carries the state it was drawn with.
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
    renderNav();
  } catch (err) {
    body.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
  }
}

// ── poll budget ─────────────────────────────────────────────────────────────
// The dashboard used to re-read every staged row on one fixed 10 s tick, hidden
// or visible, idle or running — and that read is linear in the staged set. The
// tick is now a self-scheduling timeout that picks its interval from what is
// happening (10 s while a run is active, 30 s idle), stops while the tab is
// hidden, and refreshes exactly once when it comes back.
const POLL_RUNNING_MS = 10000;
const POLL_IDLE_MS = 30000;

function pollIntervalMs() {
  return (state.running && state.running.length) ? POLL_RUNNING_MS : POLL_IDLE_MS;
}

/** Queue exactly one refresh; the next tick is scheduled after it settles. */
function schedulePoll(delay = pollIntervalMs()) {
  if (!state.live) return;
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    if (!state.live) return;
    if (document.hidden) return schedulePoll(); // a hidden tab resumes on show
    try { await refreshAll(); } catch { /* a failed poll must not stop the next */ }
    schedulePoll();
  }, delay);
}

function startLive() {
  state.live = true;
  localStorage.setItem("skyhook.live", "1");
  schedulePoll(0); // the toggle means "follow it now", so refresh immediately
}

function stopLive() {
  state.live = null;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  localStorage.setItem("skyhook.live", "0");
}

function wireLiveToggle() {
  const liveInput = $("#live");
  if (!liveInput) return;
  liveInput.checked = !!state.live;
  // Restore from localStorage if not already running.
  if (!state.live && localStorage.getItem("skyhook.live") === "1") {
    state.live = true;
    liveInput.checked = true;
    schedulePoll();
  }
  if (state._liveWired) return;
  state._liveWired = true;
  liveInput.addEventListener("change", () => {
    if (liveInput.checked) startLive();
    else stopLive();
  });
  // A hidden tab does no polling; showing it again refreshes once and resumes.
  document.addEventListener("visibilitychange", () => {
    if (!state.live) return;
    if (document.hidden) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
      return;
    }
    refreshAll().catch(() => {});
    schedulePoll();
  });
}

let logPageState = {
  source: null,
  sources: [],
  active: null,
  // What the *route* last asked for, which is not the same thing as `source`: a tab click moves the
  // tail without touching the hash, so a refresh must not read the route as "go back to that one".
  routeSource: null,
  pollTimer: null,
  followLog: true,
};

/* ── the dock and the status bar ─────────────────────────────────────────── */

/* The same log is rendered twice — the log surface (the phone keeps it) and the dock (the desktop
 * has no surface for a log). Two host lists and one fetch per tick: `renderLogBody` writes both, so
 * an open dock on any section is still exactly one tail every 2 s, not one per host. */
const LOG_TAB_HOSTS = ["logTabs", "dockTabs"];
const LOG_BODY_HOSTS = ["logBody", "dockBody"];

/* Both regions are `display: none` at 720 px and below (`styles.css`, the phone block), so the one
 * viewport question this file asks is whether the phone shell is what is on screen. */
const isPhone = () => !window.matchMedia("(min-width: 721px)").matches;

/* The third breakpoint (D19): between 721 and 1180 px the inspector is a sheet over the work surface
 * instead of a grid column. The same query the stylesheet's media block asks, so the two cannot
 * disagree about which mode is on screen. */
const isTablet = () => window.matchMedia("(min-width: 721px) and (max-width: 1180px)").matches;

/* The open state lives on `#workbench[data-dock]` and nowhere else. This writes the attribute and
 * the button that controls it together, because a toggle that disagrees with the grid is worse than
 * a dock that will not open — and `#dock` is opened by code (a deep link, a run starting) as often
 * as by the button. */
function setDockOpen(open) {
  const wb = $("#workbench");
  if (!wb) return;
  wb.dataset.dock = open ? "open" : "collapsed";
  const btn = $$(".pane-btn").find((b) => b.dataset.pane === "dock");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    const label = (open ? "Collapse " : "Expand ") + PANE_LABEL.dock;
    btn.title = label;
    const sr = btn.querySelector(".sr-only");
    if (sr) sr.textContent = label;
  }
  // A dock that was shut while a source was selected has no lines to show until it is told to ask.
  if (open) {
    renderLogPageHead();
    renderLogTabs();
    renderLogBody();
  }
  syncLogPolling();
}

/* One tail, started in one place. The timer runs while there is a source AND something on screen is
 * showing it — the log surface (phone) or the open dock (any section, which is what W5 changes).
 * `startLogPagePolling` returns early when a timer exists, so calling this freely cannot stack one. */
function syncLogPolling() {
  const wb = $("#workbench");
  const dockOpen = !!wb && wb.dataset.dock === "open";
  if (logPageState.source && (state.route.name === "log" || dockOpen)) {
    startLogPagePolling();
  } else if (logPageState.pollTimer) {
    clearInterval(logPageState.pollTimer);
    logPageState.pollTimer = null;
  }
}

/* ── the inspector sheet (D19) ───────────────────────────────────────────── */

/* The open state lives on `#workbench[data-insp-sheet]` and nowhere else, written here so the bar's
 * button, the scrim and the pane cannot disagree — `setFocus` opens the sheet as often as a click
 * does. Opening also lifts an `insp` collapse: a pane collapsed on a desktop would otherwise come
 * back as a 26 px sheet with no room for the seeder it was opened for. */
function setInspSheet(open) {
  const wb = $("#workbench");
  if (!wb) return;
  const want = !!open && isTablet();
  wb.dataset.inspSheet = want ? "open" : "closed";
  const btn = $("#inspSheetBtn");
  if (btn) btn.setAttribute("aria-expanded", String(want));
  const scrim = $("#inspScrim");
  if (scrim) scrim.dataset.open = String(want);
  // On a tablet the pane's own head button means "is the sheet showing", because the sheet is the
  // only way the pane is on screen; on a desktop it keeps meaning "is the column expanded".
  const paneBtn = isTablet() ? $$(".pane-btn").find((b) => b.dataset.pane === "insp") : null;
  if (paneBtn) {
    paneBtn.setAttribute("aria-expanded", String(want));
    const label = (want ? "Collapse " : "Expand ") + PANE_LABEL.insp;
    paneBtn.title = label;
    const sr = paneBtn.querySelector(".sr-only");
    if (sr) sr.textContent = label;
  }
  if (!want) return;
  const collapsed = new Set((wb.dataset.collapsed || "").split(/\s+/).filter(Boolean));
  if (collapsed.delete("insp")) {
    if (collapsed.size) wb.dataset.collapsed = [...collapsed].join(" ");
    else delete wb.dataset.collapsed;
  }
}

const isInspSheetOpen = () => {
  const wb = $("#workbench");
  return !!wb && wb.dataset.inspSheet === "open";
};

/* Open with the keyboard already inside the sheet — `#insp` is a `tabindex="-1"` region, so the rim
 * lights up and Tab goes to its first control — and hand it back to the bar's button on close. */
function toggleInspSheet() {
  if (isInspSheetOpen()) { setInspSheet(false); return; }
  setInspSheet(true);
  // `offsetParent` is null for a `position: fixed` element, which is exactly what the open sheet is;
  // a client rect is the question "is anything of it on screen".
  const insp = $("#insp");
  if (insp && insp.getClientRects().length) insp.focus();
}

function wireInspSheet() {
  const btn = $("#inspSheetBtn");
  if (btn) btn.addEventListener("click", toggleInspSheet);
  const scrim = $("#inspScrim");
  if (scrim) scrim.addEventListener("click", () => { setInspSheet(false); btnBackToBar(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isInspSheetOpen()) return;
    // One key, one layer: a modal and the palette own Escape while either is open.
    if (activeModal) return;
    const pal = $("#palette");
    if (pal && pal.dataset.open === "true") return;
    e.preventDefault();
    setInspSheet(false);
    btnBackToBar();
  });
  // 1180 is a width, so crossing it either way shuts the sheet: at 1181 the column is back, and at
  // 720 the phone shell has no inspector at all. The 721 edge is W5's listener (the log moves).
  window.matchMedia("(min-width: 1181px)").addEventListener?.("change", () => setInspSheet(false));
}

/* Closing the sheet leaves the focus nowhere, and nowhere means the body: hand it back to the door
 * that opened it, but only while that door is on screen. */
function btnBackToBar() {
  const btn = $("#inspSheetBtn");
  if (btn && btn.offsetParent !== null) btn.focus();
}

/* ── pane mechanics ──────────────────────────────────────────────────────── */

/* Pane sizes are the only shell state worth persisting: three integers, clamped on read so a
 * value a stale session wrote can never leave a pane unusable. They are written on :root, never
 * on #workbench, because a collapse rule re-declares the same variable on the grid container —
 * an inline value there would win and the pane could never collapse. */
const PANES = {
  nav:  { css: "--nav-w",  key: "skyhook.navW",  min: 140, max: 420, def: 220, axis: "x" },
  insp: { css: "--insp-w", key: "skyhook.inspW", min: 240, max: 560, def: 300, axis: "x" },
  dock: { css: "--dock-h", key: "skyhook.dockH", min: 120, max: 480, def: 220, axis: "y" },
};
const PANE_LABEL = { nav: "navigator", insp: "inspector", dock: "log dock" };

/* A dock taller than two fifths of the window leaves no work surface on a short screen. */
function paneMax(name) {
  return name === "dock"
    ? Math.min(PANES.dock.max, Math.round(window.innerHeight * 0.4))
    : PANES[name].max;
}

function clampPane(name, value) {
  const p = PANES[name];
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return p.def;
  return Math.min(paneMax(name), Math.max(p.min, n));
}

function currentPaneSize(name) {
  const raw = document.documentElement.style.getPropertyValue(PANES[name].css);
  return clampPane(name, parseFloat(raw) || PANES[name].def);
}

function setPaneSize(name, value, persist = false) {
  const p = PANES[name];
  const n = clampPane(name, value);
  const wb = $("#workbench");
  if (!wb) return n;
  document.documentElement.style.setProperty(p.css, n + "px");
  const split = wb.querySelector('.splitter[data-pane="' + name + '"]');
  if (split) {
    split.setAttribute("aria-valuenow", String(n));
    split.setAttribute("aria-valuemin", String(p.min));
    split.setAttribute("aria-valuemax", String(paneMax(name)));
  }
  if (persist) localStorage.setItem(p.key, String(n));
  return n;
}

function restorePaneSizes() {
  for (const name of Object.keys(PANES)) {
    const stored = localStorage.getItem(PANES[name].key);
    setPaneSize(name, stored == null ? PANES[name].def : stored);
  }
}

/* The pointer's position is the size, so a drag cannot jump by the grab offset: nav is measured
 * from the rail's edge, the inspector from the window's right, the dock from the status bar. */
function paneSizeFromPointer(name, ev) {
  const wb = $("#workbench");
  if (!wb) return PANES[name].def;
  const rect = wb.getBoundingClientRect();
  const cs = getComputedStyle(wb);
  const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
  if (name === "nav") return ev.clientX - rect.left - px("--rail-w");
  if (name === "insp") return rect.right - ev.clientX;
  return rect.bottom - ev.clientY - px("--status-h");
}

/* F6 walks the regions in visual order and skips whatever a collapse or a breakpoint hides. A
 * client rect rather than `offsetParent`, because the tablet's inspector is `position: fixed` and
 * `offsetParent` is null for every fixed element — the sheet would be invisible to F6. */
function focusNextRegion(dir) {
  const regions = ["rail", "nav", "work", "insp", "dock"]
    .map((id) => document.getElementById(id))
    .filter((el) => el && el.getClientRects().length > 0);
  if (!regions.length) return;
  const current = regions.find((el) => el.contains(document.activeElement));
  const from = current ? regions.indexOf(current) : (dir > 0 ? -1 : 0);
  regions[(from + dir + regions.length) % regions.length].focus();
}

function wirePanes() {
  const wb = $("#workbench");
  if (!wb) return;
  restorePaneSizes();

  wb.querySelectorAll(".splitter").forEach((split) => {
    const name = split.dataset.pane;
    const p = PANES[name];
    if (!p) return;
    let dragging = false;

    split.addEventListener("pointerdown", (ev) => {
      dragging = true;
      split.setPointerCapture(ev.pointerId);
      document.body.classList.add("resizing");
      document.body.style.cursor = p.axis === "x" ? "col-resize" : "row-resize";
    });
    split.addEventListener("pointermove", (ev) => {
      if (dragging) setPaneSize(name, paneSizeFromPointer(name, ev));
    });
    const stop = (ev) => {
      if (!dragging) return;
      dragging = false;
      if (split.hasPointerCapture(ev.pointerId)) split.releasePointerCapture(ev.pointerId);
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
      setPaneSize(name, currentPaneSize(name), true);
    };
    split.addEventListener("pointerup", stop);
    split.addEventListener("pointercancel", stop);
    split.addEventListener("dblclick", () => setPaneSize(name, p.def, true));

    // A separator only a pointer can move is not reachable by keyboard at all.
    split.addEventListener("keydown", (ev) => {
      const now = currentPaneSize(name);
      const step = ev.shiftKey ? 48 : 16;
      let next = null;
      if (p.axis === "x" && ev.key === "ArrowLeft") next = now - step;
      if (p.axis === "x" && ev.key === "ArrowRight") next = now + step;
      if (p.axis === "y" && ev.key === "ArrowUp") next = now - step;
      if (p.axis === "y" && ev.key === "ArrowDown") next = now + step;
      if (ev.key === "Home") next = p.def;
      if (next == null) return;
      ev.preventDefault();
      setPaneSize(name, next, true);
    });
  });


  // Collapse toggles. The dock has its own state (`#workbench[data-dock]`), written only through
  // `setDockOpen` so the button and the grid can never disagree; nav and inspector share
  // `data-collapsed` as a whitespace-separated list.
  $$(".pane-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.pane;
      const open = btn.getAttribute("aria-expanded") !== "true";
      if (name === "dock") {
        setDockOpen(open);
      } else if (name === "insp" && isTablet()) {
        // The inspector is a sheet here, not a column: its head button toggles the sheet, and
        // `setInspSheet` writes this same button's `aria-expanded` (D19).
        toggleInspSheet();
        return;
      } else {
        btn.setAttribute("aria-expanded", String(open));
        const label = (open ? "Collapse " : "Expand ") + (PANE_LABEL[name] || name);
        btn.title = label;
        const sr = btn.querySelector(".sr-only");
        if (sr) sr.textContent = label;
        const collapsed = new Set((wb.dataset.collapsed || "").split(/\s+/).filter(Boolean));
        if (open) collapsed.delete(name); else collapsed.add(name);
        if (collapsed.size) wb.dataset.collapsed = [...collapsed].join(" ");
        else delete wb.dataset.collapsed;
      }
      // Focus must not die inside the pane that just went away.
      const pane = document.getElementById(name);
      if (!open && pane && pane.contains(document.activeElement)) $("#work").focus();
    });
  });

  // A restored size can be too tall for a window that shrank since it was stored.
  window.addEventListener("resize", () => {
    for (const name of Object.keys(PANES)) setPaneSize(name, currentPaneSize(name));
  });
}


/* Row focus is a roving tabindex: one row of the seeder table is Tab-reachable and the arrows
 * move inside it. What is *picked* is `state.focus` (below) — this decides only where focus lands
 * and how it leaves; the two are separate on purpose, or arrowing would refetch on every step. */
let rowFocusSource = null;

function roveTo(tr) {
  const tbody = $("#seederBody");
  if (!tbody || !tr) return;
  for (const row of tbody.rows) row.tabIndex = row === tr ? 0 : -1;
  rowFocusSource = tr.dataset.source || null;
}

function wireRowFocus() {
  const tbody = $("#seederBody");
  if (!tbody) return;
  tbody.addEventListener("focusin", (ev) => {
    const tr = ev.target.closest("tr");
    if (tr && tr.parentElement === tbody) roveTo(tr);
  });
  tbody.addEventListener("keydown", (ev) => {
    const tr = ev.target.closest("tr");
    if (!tr || tr.parentElement !== tbody) return;
    const rows = [...tbody.rows];
    const at = rows.indexOf(tr);
    let next = null;
    if (ev.key === "ArrowDown") next = rows[Math.min(at + 1, rows.length - 1)];
    else if (ev.key === "ArrowUp") next = rows[Math.max(at - 1, 0)];
    else if (ev.key === "Home") next = rows[0];
    else if (ev.key === "End") next = rows[rows.length - 1];
    else if (ev.key === "Enter" && ev.target === tr) {
      // Enter is the keyboard's click, so it picks. A key pressed on the row's own link or
      // checkbox is that control's, and never reaches here.
      ev.preventDefault();
      setFocus(tr.dataset.source);
      return;
    }
    if (!next) return;
    ev.preventDefault();
    roveTo(next);
    next.focus();
  });
}


/* ── selection and the inspector (W3) ─────────────────────────────────────
 * One pick at a time, held in `state.focus`. The inspector renders from `state.seeders`, which the
 * list already fetched, so a refresh costs no request; only history and the staged count are
 * fetched, and only when the pick changes or the focused seeder's last run does. A poll that
 * refetched both every 10 s would put a source's whole staged set on the wire 8,640 times a day. */

const RUN_BARS = 20;

function focusedSeeder() {
  return state.seeders.find((s) => s.source === state.focus) || null;
}

function setFocus(source) {
  if (!source) { clearFocus(); return; }
  // A pick is the sheet's second door (D19), and it has to work on a repeat pick too: the row can
  // still be the focused one while the sheet is closed.
  setInspSheet(true);
  if (state.focus === source) return;
  // Re-rendering the table replaces the row the keyboard was on, so the new one takes focus back.
  const hadRow = document.activeElement && document.activeElement.tagName === "TR"
    && document.activeElement.dataset.source === source;
  state.focus = source;
  state.inspRuns = null;
  state.inspStaged = null;
  state.inspRunAt = null;
  renderSeeders();
  if (hadRow) {
    const tr = $$("#seederBody tr").find((row) => row.dataset.source === source);
    if (tr) tr.focus();
  }
  renderInspector();
  loadInspector(source);
}

function clearFocus() {
  // Nothing picked means nothing to inspect: the sheet goes even when the button opened it.
  setInspSheet(false);
  if (!state.focus) return;
  state.focus = null;
  state.inspRuns = null;
  state.inspStaged = null;
  state.inspRunAt = null;
  renderInspector();
}

async function loadInspector(source) {
  const seq = ++state.inspSeq;
  const before = (state.seeders.find((s) => s.source === source) || {}).lastRunAt || null;
  const [runs, staged] = await Promise.all([
    get("/api/history/" + encodeURIComponent(source)).catch(() => []),
    get("/api/staged?source=" + encodeURIComponent(source)).catch(() => null),
  ]);
  // A click on another row wins: a late answer for the previous pick is dropped, not painted.
  if (seq !== state.inspSeq || state.focus !== source) return;
  state.inspRuns = Array.isArray(runs) ? runs : [];
  state.inspStaged = staged && Array.isArray(staged.rows) ? staged.rows.length : null;
  state.inspRunAt = before;
  renderInspector();
}

function renderInspector() {
  const body = $("#inspBody");
  if (!body) return;
  const s = focusedSeeder();
  if (!s) {
    body.innerHTML =
      '<p class="pane-empty">Nothing selected.</p>' +
      '<p class="pane-note">Pick a seeder in the work surface to see its cadence, recent runs and actions.</p>';
    return;
  }
  // A run that finished since the fetch leaves the cached history one run short: refetch it.
  if (state.inspRuns && state.inspRunAt !== (s.lastRunAt || null)) loadInspector(s.source);

  const result = resultText(s.lastResult);
  const facts = [
    ["Script", esc(s.script)],
    ["Cadence", esc(s.cadence) + (s.scheduled ? "" : ' <span class="muted">manual</span>')],
    ["Next run", esc(fmtIn(s.nextRunAt))],
    ["Last run", esc(fmtAgo(s.lastRunAt))],
    ["Last result", esc(result || "-"), s.lastStatus === "ok" ? "ok" : s.lastStatus ? "err" : ""],
    ["Duration", esc(fmtElapsed(s.lastDurationMs))],
    ["Staged rows", state.inspStaged == null ? "-" : String(state.inspStaged)],
    ["Category", esc(s.categoryLabel || "") + (s.subcategoryLabel ? " · " + esc(s.subcategoryLabel) : "")],
    ["Node", esc(s.node || "-")],
  ];
  if (s.lastError) facts.push(["Error", esc(s.lastError), "err"]);

  const actions = [
    ["run", "Run", "ic-play"],
    ["schedule", "Schedule", "ic-cog"],
    ["toggle", s.scheduled ? "Disable" : "Enable", "ic-power"],
    ["log", "Log", "ic-terminal"],
    ["curation", "Curation", "ic-tag"],
  ].map(([act, label, icon]) =>
    '<button class="btn btn-sm" type="button" data-insp="' + act + '">' +
      '<svg class="ic" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
      "<span>" + esc(label) + "</span></button>").join("");

  body.innerHTML =
    '<div class="insp">' +
      '<div class="insp-id">' +
        '<div class="insp-title" title="' + esc(s.script) + '">' + esc(s.source) + "</div>" +
        '<div class="insp-sub">' + esc(s.displayName || s.script) + "</div>" +
      "</div>" +
      '<div class="insp-actions">' + actions + "</div>" +
      '<div class="info-grid">' +
        facts.map(([k, v, cls]) =>
          '<div class="info-k">' + esc(k) + '</div>' +
          '<div class="info-v' + (cls ? " " + cls : "") + '">' + v + "</div>").join("") +
      "</div>" +
      '<div class="insp-section"><span>Recent runs</span>' +
        "<span>" + (state.inspRuns == null ? "-" : state.inspRuns.length) + "</span></div>" +
      runStrip(state.inspRuns) +
    "</div>";
}

/* The strip is one bar per run, so a source that fails every other time *looks* like one. Bar height
 * is rows found, colour is the run's status; the newest is at the right, where a reader's eye lands. */
function runStrip(runs) {
  if (runs == null) return '<p class="pane-note">Loading history...</p>';
  if (!runs.length) return '<p class="pane-note">No runs recorded yet.</p>';
  const recent = runs.slice(0, RUN_BARS).reverse();
  const peak = Math.max(1, ...recent.map((r) => (r.staged || 0) + (r.dead || 0)));
  const step = 100 / RUN_BARS;
  const bars = recent.map((r, i) => {
    const found = (r.staged || 0) + (r.dead || 0);
    const h = Math.max(1.5, Math.round((16 * found / peak) * 10) / 10);
    const cls = r.status === "ok" ? "ok" : "err";
    const tip = r.started_at + " - " + r.status + ", staged " + (r.staged || 0) + ", dead " + (r.dead || 0);
    return '<rect class="insp-run ' + cls + '" x="' + (i * step + 0.8).toFixed(1) +
      '" y="' + (20 - h).toFixed(1) + '" width="' + (step - 1.6).toFixed(1) + '" height="' + h + '">' +
      "<title>" + esc(tip) + "</title></rect>";
  }).join("");
  return '<svg class="insp-runs" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label="' +
    esc("The last " + recent.length + " runs, oldest first") + '">' + bars + "</svg>";
}

/* Every action here is a button the table already has, reached through the same function — the
 * inspector is a second way in, never a second implementation. */
function wireInspector() {
  const body = $("#inspBody");
  if (!body) return;
  body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-insp]");
    const source = state.focus;
    if (!btn || !source) return;
    const act = btn.dataset.insp;
    if (act === "run") runSources([source]);
    else if (act === "schedule") openSchedule(source);
    else if (act === "toggle") toggleSchedule(source);
    else if (act === "log") navigate("#/log/" + encodeURIComponent(source));
    else if (act === "curation") navigate("#/curation");
  });
}


function openLogPage(source) {
  logPageState.source = source;
  logPageState.routeSource = source || null;
  const runningSources = state.running.map((r) => r.source);
  const sources = [...new Set([source].concat(runningSources))].filter(Boolean);
  logPageState.sources = sources;
  logPageState.active = source;
  renderLogPageHead();
  renderLogTabs();
  renderLogBody();
  syncLogPolling();
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
  // The dock head says the same thing in one phrase: what is tailing, and for how long, because the
  // elapsed number is the only evidence a run is still alive rather than merely unfinished.
  const note = $("#dockNote");
  if (note) {
    if (!logPageState.source) note.textContent = "no log open";
    else if (running) note.textContent = "live · " + fmtElapsed(running.elapsedMs);
    else note.textContent = logPageState.sources.length + (logPageState.sources.length === 1 ? " log" : " logs");
    note.toggleAttribute("data-live", !!running);
  }
}

function renderLogTabs() {
  const running = new Map(state.running.map((r) => [r.source, r]));
  const html = logPageState.sources.map((src) => {
    const run = running.get(src);
    const isActive = src === logPageState.active;
    const cls = ["log-tab", isActive && "active", run && "live"].filter(Boolean).join(" ");
    return '<button class="' + cls + '" data-logtab="' + esc(src) + '" role="tab" aria-selected="' + (isActive ? "true" : "false") + '">' +
      '<span class="spin-pulse" aria-hidden="true"></span>' +
      '<span>' + esc(src) + '</span>' +
      (run ? '<span class="time">' + esc(fmtElapsed(run.elapsedMs)) + '</span>' : "") +
    '</button>';
  }).join("");
  for (const id of LOG_TAB_HOSTS) {
    const container = $("#" + id);
    if (container) container.innerHTML = html;
  }
}

let logRenderSeq = 0;
async function renderLogBody() {
  const seq = ++logRenderSeq;
  const bodies = LOG_BODY_HOSTS.map((id) => $("#" + id)).filter(Boolean);
  if (!bodies.length) return;
  if (!logPageState.sources.length) {
    for (const b of bodies) b.innerHTML = '<p class="log-empty">No sources.</p>';
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
  // The fetch happened once; each host keeps its own follow position, because the person may be
  // reading in the dock while the surface sits scrolled somewhere else.
  if (seq !== logRenderSeq) return;
  const html = blocks.join("");
  for (const b of bodies) {
    const prevScroll = b.scrollTop;
    b.innerHTML = html;
    b.scrollTop = logPageState.followLog ? b.scrollHeight : prevScroll;
  }
}

// The log page refreshes the visible tab only: `renderLogBody` fetches one
// source, so the cost of an open log is `loadRunning` + that one tail every
// tick. 2 s is fast enough for a human reading it, and a hidden tab does
// nothing at all — showing it again refreshes once.
const LOG_POLL_MS = 2000;

function startLogPagePolling() {
  if (!logPageState._visWired) {
    logPageState._visWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !logPageState.pollTimer) return;
      renderLogPageHead();
      renderLogTabs();
      renderLogBody(); // one immediate refresh on return
    });
  }
  if (logPageState.pollTimer) return;
  logPageState.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    await loadRunning();
    const runningSources = state.running.map((r) => r.source);
    const newSources = runningSources.filter((s) => logPageState.sources.indexOf(s) === -1);
    if (newSources.length) logPageState.sources = logPageState.sources.concat(newSources);
    renderLogPageHead();
    renderLogTabs();
    await renderLogBody();
  }, LOG_POLL_MS);
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

/* The table's power button and the inspector's are the same request; a schedule toggle is one
 * decision either way, so it lives in one function and both call it. */
function toggleSchedule(source) {
  const s = state.seeders.find((x) => x.source === source);
  const p = s && s.scheduled
    ? post("/api/disable", { source }).then(() => toast("Disabled " + source + "."))
    : post("/api/enable", { source, cadence: "weekly" }).then(() => toast("Enabled " + source + " (weekly)."));
  return p.then(refreshAll);
}

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
    state.lastRefreshAt = Date.now();
    $("#apiLabel").textContent = "api → " + apiBase();
    $("#apiLabel").classList.remove("offline");
    // A run that starts while the dock is shut would stream where nobody can see it, so the
    // idle -> running edge opens the dock and picks that source. Nothing closes it: a dock the user
    // opened is theirs, and a page load starts collapsed (`index.html`).
    const isRunning = state.running.length > 0;
    if (isRunning && !state.wasRunning && !isPhone()) {
      if (!logPageState.source) openLogPage(state.running[0].source);
      setDockOpen(true);
    }
    state.wasRunning = isRunning;
    renderStatus();
    // Don't re-render the Settings panel during auto-refresh — it tears down
    // the live toggle and resets the checkbox state.
    if (state.route.name !== "settings") handleRouteChange();
  } catch (err) {
    offlineFails++;
    $("#apiLabel").textContent = "offline — " + err.message;
    $("#apiLabel").classList.add("offline");
    renderStatus();
    if (offlineFails === 3) toast("Cannot reach API: " + err.message, "err");
  }
}

/* The status bar is rebuilt from `state` whole, never edited field by field: every value it shows
 * is one a poll just refreshed, so one function is what keeps them from disagreeing. "synced" is
 * this console's last successful poll — no route returns a sync timestamp, and the fleet's own last
 * run is the dashboard's business, not a footer's. */
const hhmmss = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

function renderStatus() {
  const base = apiBase();
  const endpoint = $("#statusEndpoint");
  if (endpoint) {
    endpoint.textContent = base.replace(/^https?:\/\//, "");
    endpoint.title = "API " + base;
  }
  const badge = $("#seederCountBadge");
  if (badge) badge.textContent = String(state.seeders.length);
  const due = dueNowClient().length;
  const dueEl = $("#statusDue");
  if (dueEl) {
    dueEl.textContent = due + " due";
    dueEl.classList.toggle("due", due > 0);
  }
  const nodeEl = $("#statusNode");
  if (nodeEl) nodeEl.textContent = state.nodeId || "local";
  const routeEl = $("#statusRoute");
  if (routeEl) routeEl.textContent = state.route.name;
  const syncEl = $("#statusSync");
  if (syncEl) {
    syncEl.textContent = state.lastRefreshAt ? "synced " + hhmmss(state.lastRefreshAt) : "synced —";
    // Twice the idle interval means the poll has stopped landing: a timestamp that still looks
    // fresh would be the lie, so it changes colour instead of ticking.
    syncEl.classList.toggle("stale", !state.lastRefreshAt || Date.now() - state.lastRefreshAt > 2 * POLL_IDLE_MS);
  }
}


// ─── event wiring (delegation) ─────────────────────────────────────────

function bind() {
  $("#refreshBtn").addEventListener("click", () => refreshAll());
  $("#apiBaseBtn")?.addEventListener("click", openApiBasePrompt);

  const filterEl = $("#filter");
  if (filterEl) filterEl.addEventListener("input", debounce(renderSeeders, 80));

  // The navigator and the chips are delegated: renderNav/renderSeeders repaint them on every poll,
  // so a listener bound to a node would be thrown away with the node. A row with no `data-nav-*`
  // (the due-now links) is an anchor and navigates itself.
  const navEl = $("#navTree");
  if (navEl) navEl.addEventListener("click", (e) => {
    const node = e.target.closest("button");
    if (!node) return;
    const d = node.dataset;
    if (d.navQuick) return setQuick(d.navQuick);
    if (d.navCat !== undefined) return toggleNav("category", d.navCat);
    if (d.navSub !== undefined) return toggleNav("subcategory", d.navSub);
    if (d.navPick) return setFocus(d.navPick);
    if (d.navCurate) return scrollToRow("curationBody", "data-curation-source", d.navCurate);
    if (d.navJob) return scrollToRow("pipelineJobs", "data-job", d.navJob);
  });
  const chipsEl = $("#activeFilters");
  if (chipsEl) chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-clearfilter]");
    if (chip) clearFilter(chip.dataset.clearfilter);
  });

  // Bound once, for the same reason the navigator is: `renderSettings` repaints `#settingsBody` on
  // every visit and after every toggle, so a listener inside it survived as one copy per render
  // (#40). The button carries the state it was drawn with, so the handler needs no closure.
  const settingsEl = $("#settingsBody");
  if (settingsEl) settingsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("#toggleRemoteBtn");
    if (btn) toggleRemote(btn.dataset.remoteOn === "1");
  });

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
      if (btn) {
        const action = btn.dataset.action;
        const source = btn.dataset.source;
        if (action === "run") runSources([source]);
        else if (action === "schedule") openSchedule(source);
        else if (action === "toggle") toggleSchedule(source);
        return;
      }
      // A click anywhere else in the row is the pick (W3). The source link and the checkbox keep
      // their own behaviour, so a click on the name still opens its log and nothing is swallowed.
      if (e.target.closest("a, input, button, label")) return;
      const picked = e.target.closest("[data-source]");
      if (picked) setFocus(picked.dataset.source);
    });
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("a, input, button, label")) return;
      const picked = e.target.closest("[data-source]");
      if (picked) setFocus(picked.dataset.source);
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
  if (rd) rd.addEventListener("click", () => runDue());
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
  if (pb) pb.addEventListener("click", () => pruneStaged());
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
  // The same tabs exist twice — the log surface (which the phone keeps) and the dock (the desktop's
  // only log) — so one delegation per host keeps both live without either owning the other.
  for (const id of LOG_TAB_HOSTS) {
    const host = $("#" + id);
    if (!host) continue;
    host.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-logtab]");
      if (!tab) return;
      // The head, the Run button and the tail all read `source`; only `active` used to move, so a
      // clicked tab streamed one source's lines under another source's name.
      logPageState.source = tab.dataset.logtab;
      logPageState.active = tab.dataset.logtab;
      logPageState.followLog = true;
      renderLogPageHead();
      renderLogTabs();
      renderLogBody();
      syncLogPolling();
    });
  }
  // Following is per host: scrolling the dock must not stop the surface from following, and the
  // flag is shared, so the last scroll wins — which is the pane the person is actually reading.
  for (const id of LOG_BODY_HOSTS) {
    const b = $("#" + id);
    if (!b) continue;
    b.addEventListener("scroll", () => {
      logPageState.followLog = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
    });
  }

  const wt = $("#writeTimerBtn");
  if (wt) wt.addEventListener("click", writeTimer);

  // The sheet is the only place tier/schedule/status are set now, so it must open on what is
  // already applied — and offer the way off. Applying a blank form used to reset them silently.
  const modalSelect = (id, current, opts) =>
    '<select id="' + id + '">' + opts.map(([v, label]) =>
      '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(label) + "</option>").join("") +
    "</select>";
  const fs = $("#filterSheetBtn");
  if (fs) fs.addEventListener("click", () => {
    const f = state.filters;
    openModal((modal) => {
      const body = document.createElement("div");
      body.className = "modal-body";
      body.innerHTML =
        '<div class="field"><label for="modalTier">Tier</label>' +
          modalSelect("modalTier", f.tier, [["", "All tiers"], ["news", "News"], ["evergreen", "Evergreen"]]) +
        '</div>' +
        '<div class="field"><label for="modalSched">Schedule</label>' +
          modalSelect("modalSched", f.sched, [["", "Scheduled + manual"], ["1", "Scheduled only"], ["0", "Manual only"]]) +
        '</div>' +
        '<div class="field"><label for="modalStatus">Status</label>' +
          modalSelect("modalStatus", f.status, [["", "Any status"], ["due", "Due"], ["errors", "Errors"]]) +
        '</div>';
      const clear = mkBtn("Clear all", "btn");
      clear.addEventListener("click", () => {
        Object.assign(state.filters, EMPTY_FILTERS);
        closeModal();
        renderSeeders();
      });
      const apply = mkBtn("Apply", "btn-primary");
      apply.addEventListener("click", () => {
        state.filters.tier = $("#modalTier").value;
        state.filters.sched = $("#modalSched").value;
        state.filters.status = $("#modalStatus").value;
        closeModal();
        renderSeeders();
      });
      modalShell(modal, { title: "More filters", body, actions: [clear, apply] });
    });
  });

  wirePanes();
  wireRowFocus();
  wireInspector();
  wirePalette();
  wireInspSheet();

  // Keyboard shortcuts (skip when typing in a form).
  document.addEventListener("keydown", (e) => {
    // Above the typing guard on purpose: any field can hold the focus when the palette is asked
    // for — `#filter` most of the time — and `Ctrl/Cmd+K` is the one shortcut that must still work
    // from inside a form. It toggles, because a second press is how a keyboard user backs out.
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
      e.preventDefault();
      if ($("#palette") && $("#palette").dataset.open === "true") closePalette();
      else openPalette();
      return;
    }
    if (e.key === "F6") { e.preventDefault(); focusNextRegion(e.shiftKey ? -1 : 1); return; }
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
  // Crossing 720 px swaps the log between the dock and the surface, so what a route means changes
  // with it and the route has to be read again. W7 owns the 1180 px sheet; this one is W5's.
  window.matchMedia("(min-width: 721px)").addEventListener?.("change", handleRouteChange);
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

/* One handler per heavy or destructive action, named rather than left inside a click listener:
 * the palette and the button it mirrors have to reach the same code, or W6's "Enter reaches the
 * handler the button does" is a claim about two copies that will drift. */
function runDue() {
  const force = !!($("#forceDue") && $("#forceDue").checked);
  return runSources(state.seeders.filter(force ? (s) => s.scheduled : isDueClient).map((s) => s.source));
}

function pruneStaged(opts) {
  const filter = {};
  const srcEl = $("#curateSource"), beforeEl = $("#curateBefore");
  const src = srcEl ? srcEl.value.trim() : "";
  const before = beforeEl ? beforeEl.value : "";
  if (src) filter.source = src;
  if (before) filter.before = before;
  // From the palette those two fields can be on another section — or empty, which prunes the whole
  // staged set — so that path names what it is about to move to `.skyhook/trash/` first (D18).
  if (opts && opts.confirm) {
    const what = src ? "staged URLs from " + src : "every staged URL";
    const when = before ? " staged before " + before : "";
    if (!confirm("Prune " + what + when + "? Rows move to .skyhook/trash/ — they are not destroyed.")) {
      return Promise.resolve();
    }
  }
  return post("/api/cache/prune", { filter })
    .then((r) => {
      toast("Deleted " + r.deleted + " URL(s) (kept " + r.kept + ").", "ok");
      renderCuration();
    })
    .catch((err) => toast(err.message, "err"));
}

/* ── command palette (W6) ────────────────────────────────────────────────────
 * Three kinds of row behind one input: the sections `ROUTE_TITLES` names, five actions, and
 * per-seeder rows once something is typed. It is not a `.modal` (D16) — the palette's focus never
 * leaves its input, and `aria-activedescendant` is what moves, not a Tab cycle — so it owns
 * `openPalette`/`closePalette` and leaves the nine dialogs `openModal` serves untouched.
 * Rows are rebuilt per keystroke from `state.seeders`, so a poll that replaces the fleet cannot
 * leave a row pointing at a seeder that is gone. */
const PALETTE_CAP = 50;      // rows on screen at once: a wall of options is not a palette
const PALETTE_SEEDERS = 8;   // seeders matched per keystroke, three rows each (D17)

let paletteItems = [], paletteSel = 0, paletteReturnFocus = null;

/* A prefix beats a hit inside the label, that beats a subsequence, and no match means no row.
 * Case-folded: a source is `Lobsters` but nobody types the shift. */
function fuzzyScore(query, text) {
  const t = String(text || "").toLowerCase();
  if (!query) return 1;
  const at = t.indexOf(query);
  if (at === 0) return 200 - Math.min(t.length, 100);
  if (at > 0) return 120 - Math.min(at, 60);
  let pos = 0, gaps = 0;
  for (const ch of query) {
    const hit = t.indexOf(ch, pos);
    if (hit === -1) return 0;
    gaps += hit - pos;
    pos = hit + 1;
  }
  return Math.max(1, 60 - gaps);
}

function paletteCommands() {
  const rows = [];
  // `ROUTE_TITLES`' own order is the rail's; `timer` is a Pi node's section, and the rail hides it
  // everywhere else, so the palette offers it exactly where the rail does.
  for (const [name, label] of Object.entries(ROUTE_TITLES)) {
    if (name === "timer" && !isPiNode()) continue;
    rows.push({
      group: "Views", label, hint: name,
      run: () => navigate(name === "dashboard" ? "#/" : "#/" + name),
    });
  }
  rows.push(
    { group: "Actions", label: "Refresh everything", hint: "r", run: () => refreshAll() },
    { group: "Actions", label: "Run due seeders", hint: "run due", run: () => runDue() },
    { group: "Actions", label: "Prune staged URLs", hint: "curation", run: () => pruneStaged({ confirm: true }) },
    { group: "Actions", label: "Push staged to storage", hint: "pipeline", run: () => startPipeline("push") },
    { group: "Actions", label: "Regenerate the systemd timer", hint: "timer", run: () => writeTimer() },
  );
  return rows;
}

/** The rows for `query`, by section and then by how well each matched. */
function paletteMatches(query) {
  const q = query.trim().toLowerCase();
  const rows = paletteCommands();
  // Per-seeder rows appear only once something is typed (D17): an empty palette listing three
  // rows for every seeder in a fleet of hundreds is a scroll, not a command list.
  if (q) {
    const hits = state.seeders
      .map((s) => ({ s, score: Math.max(fuzzyScore(q, s.source), fuzzyScore(q, s.displayName)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PALETTE_SEEDERS);
    for (const { s } of hits) {
      // A display name is what the table shows, so it becomes the hint rather than a second label.
      const note = s.displayName && s.displayName !== s.source ? s.displayName : "";
      rows.push(
        { group: "Seeders", label: "Log: " + s.source, hint: note || "open log",
          run: () => navigate("#/log/" + encodeURIComponent(s.source)) },
        { group: "Seeders", label: "Run: " + s.source, hint: note || "run now",
          run: () => runSources([s.source]) },
        { group: "Seeders", label: "Schedule: " + s.source, hint: note || "cadence",
          run: () => openSchedule(s.source) },
      );
    }
  }
  const rank = { Views: 0, Actions: 1, Seeders: 2 };
  return rows
    .map((row, i) => ({ ...row, i, score: Math.max(fuzzyScore(q, row.label), fuzzyScore(q, row.hint)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => (rank[a.group] - rank[b.group]) || (b.score - a.score) || (a.i - b.i))
    .slice(0, PALETTE_CAP);
}

function renderPalette() {
  const list = $("#palList"), input = $("#palInput");
  if (!list || !input) return;
  if (!paletteItems.length) {
    list.innerHTML = '<p class="pal-empty">Nothing matches.</p>';
    input.removeAttribute("aria-activedescendant");
    return;
  }
  let html = "", group = null;
  paletteItems.forEach((row, i) => {
    if (row.group !== group) {
      if (group) html += "</div>";
      group = row.group;
      html += '<div class="pal-sec" role="group" aria-label="' + esc(group) + '">' +
        '<span class="pal-sec-label" aria-hidden="true">' + esc(group) + "</span>";
    }
    html += '<button type="button" role="option" tabindex="-1" id="pal-opt-' + i + '"' +
      ' class="pal-item' + (i === paletteSel ? " sel" : "") + '"' +
      ' aria-selected="' + (i === paletteSel ? "true" : "false") + '" data-pal="' + i + '">' +
      '<span class="pal-label">' + esc(row.label) + "</span>" +
      (row.hint ? '<span class="pal-hint">' + esc(row.hint) + "</span>" : "") +
      "</button>";
  });
  if (group) html += "</div>";
  list.innerHTML = html;
  input.setAttribute("aria-activedescendant", "pal-opt-" + paletteSel);
  const selected = $("#pal-opt-" + paletteSel);
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  const layer = $("#palette");
  if (!layer) return;
  // Two traps and one Escape key would fight: a sheet closes first, the palette never stacks on it.
  closeModal();
  if (layer.dataset.open === "true") { $("#palInput").focus(); return; }
  paletteReturnFocus = document.activeElement;
  paletteSel = 0;
  $("#palInput").value = "";
  paletteItems = paletteMatches("");
  layer.dataset.open = "true";
  renderPalette();
  $("#palInput").focus();
}

function closePalette() {
  const layer = $("#palette");
  if (!layer || layer.dataset.open !== "true") return;
  layer.dataset.open = "false";
  // Only back into something still on screen: Enter may have just replaced the surface the focus
  // came from, and focusing a detached node silently drops the caret on `<body>`.
  if (paletteReturnFocus && paletteReturnFocus.isConnected && paletteReturnFocus.focus) {
    paletteReturnFocus.focus();
  }
  paletteReturnFocus = null;
}

function paletteRun() {
  const row = paletteItems[paletteSel];
  if (!row) return;
  closePalette();
  row.run();
}

function paletteMove(delta) {
  if (!paletteItems.length) return;
  paletteSel = (paletteSel + delta + paletteItems.length) % paletteItems.length;
  renderPalette();
}

function wirePalette() {
  const layer = $("#palette"), btn = $("#paletteBtn"), input = $("#palInput"), list = $("#palList");
  if (!layer || !input || !list) return;
  if (btn) btn.addEventListener("click", openPalette);
  input.addEventListener("input", () => {
    paletteSel = 0;
    paletteItems = paletteMatches(input.value);
    renderPalette();
  });
  // The input is the palette's only tab stop by design (D16), so every key that moves the
  // selection is handled here — a `Tab` would otherwise leave the list the arrow keys drive.
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteMove(-1); }
    else if (e.key === "Home") { e.preventDefault(); paletteSel = 0; renderPalette(); }
    else if (e.key === "End") { e.preventDefault(); paletteSel = Math.max(0, paletteItems.length - 1); renderPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); paletteRun(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    else if (e.key === "Tab") { e.preventDefault(); }
  });
  // Delegated on the list, not per row: every keystroke rewrites the rows.
  list.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-pal]");
    if (!opt) return;
    paletteSel = Number(opt.dataset.pal) || 0;
    paletteRun();
  });
  layer.addEventListener("click", (e) => { if (e.target === layer) closePalette(); });
}

/* The affordances a window cannot honour, removed rather than hidden so nothing in
 * the DOM can be tabbed to or brought back by a later render: the API-base prompt
 * (the shell chose the server) and the PWA manifest (a webview cannot install one). */
function applyDesktopChrome() {
  if (!isDesktop()) return;
  $("#apiBaseBtn")?.remove();
  document.querySelector('link[rel="manifest"]')?.remove();
}

async function init() {
  applyDesktopChrome();
  $("#apiLabel").textContent = "api: " + apiBase();
  bind();
  await loadCategories();
  await refreshAll();
  // "Follow the fleet" is restored from localStorage by wireLiveToggle; the
  // refresh above is what tells the scheduler whether a run is active.
  if (state.live) schedulePoll();
  handleRouteChange();
}

init().catch((err) => {
  console.error("init failed:", err);
  document.body.innerHTML =
    '<div style="padding:24px;color:var(--err);font-family:var(--font-mono);">' +
      '<h1>Skyhook GUI failed to start</h1>' +
      '<pre>' + esc(err.message) + '\n' + esc(err.stack || "") + '</pre>' +
      '<p>Check the browser dev tools console for details.</p>' +
    '</div>';
});
