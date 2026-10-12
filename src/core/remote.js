/**
 * remote.js — cross-node control plane (PC ⇄ Pi).
 *
 * A node is identified by `config.node.id`. Manifest entries may carry a `node`
 * field naming the peer that should run them. `routeSeeders()` splits a run
 * request into local + per-peer buckets; the CLI/API then forward the remote
 * buckets to the peer's HTTP API (`skyhook serve`) and run the local bucket
 * normally. Shared secret comes from `config.remote.token` (or SKYHOOK_REMOTE_TOKEN).
 */
import { getConfig, nodeId } from "../config.js";
import { allowRemote } from "./settings.js";

export function localNodeId() {
  return nodeId();
}

export function isRemoteEnabled() {
  return allowRemote();
}

export function remoteToken() {
  return getConfig().remote?.token || process.env.SKYHOOK_REMOTE_TOKEN || null;
}

export function getPeers() {
  const peers = getConfig().remote?.peers ?? [];
  return peers.filter((p) => p && p.id && p.url);
}

export function peerFor(id) {
  return getPeers().find((p) => p.id === id) ?? null;
}

/** Split a list of seeders into { local, remote: Map<peerId, seeders> }. */
export function routeSeeders(seeders) {
  const local = [];
  const remote = new Map();
  const me = localNodeId();
  for (const s of seeders) {
    const node = s.node ?? null;
    if (!node || node === me) {
      local.push(s);
    } else {
      if (!remote.has(node)) remote.set(node, []);
      remote.get(node).push(s);
    }
  }
  return { local, remote };
}

async function request(peer, method, path, body, { timeoutMs = 30000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = remoteToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(peer.url).replace(/\/+$/, "")}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `remote ${peer.id}: HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function ping(peer) {
  return request(peer, "GET", "/api/health");
}

export async function forwardRun(peer, sources, opts = {}) {
  return request(peer, "POST", "/api/run", { sources, ...opts });
}

export async function forwardSchedule(peer, payload) {
  return request(peer, "POST", "/api/schedule", payload);
}

export async function pullStaged(peer, opts = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const q = qs.toString();
  return request(peer, "GET", `/api/staged${q ? `?${q}` : ""}`);
}

export async function pushStaged(peer, rows) {
  return request(peer, "POST", "/api/staged/import", { rows });
}

/** Best-effort: forward a run to a peer and return its result summary. */
export async function runRemote(peer, seeders, opts = {}) {
  const sources = seeders.map((s) => s.source);
  const res = await forwardRun(peer, sources, opts);
  return { peer: peer.id, sources, ...res };
}
