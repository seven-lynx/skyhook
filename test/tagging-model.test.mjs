/**
 * tagging-model.test.mjs — what `tag` does about the configured model id.
 *
 * The worker sends whatever `tagging.model` says. When that id is not what the
 * provider lists (a quantisation suffix, a typo, an unloaded model) the old
 * behaviour was a run that failed at the first completion with the model's own
 * error. The rule now: resolve against the provider, load it when the provider
 * can, and refuse naming the ids it does have. Stubbed fetch, no listener.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaggingModel } from "../src/adapters/tagging/index.js";

const provider = { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: null };
const LISTED = "qwen2.5-7b-instruct";

/** A native-LM-Studio stub: one listed model, loaded on request. */
function stub(models, { loads = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || "GET", body: init.body });
    if (target.includes("/api/v1/models/load")) {
      loads.push(String(init.body));
      return new Response(JSON.stringify({ instance_id: "inst-1", load_time_seconds: 2.5 }), { status: 200 });
    }
    if (target.includes("/api/v1/models")) {
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return calls;
}

const original = globalThis.fetch;

test("a listed but unloaded model is loaded before the pass", async () => {
  const loads = [];
  stub([{ key: LISTED, display_name: LISTED, loaded_instances: [] }], { loads });
  try {
    const result = await resolveTaggingModel(provider, LISTED);
    assert.equal(result.ok, true);
    assert.equal(result.loaded, true);
    assert.equal(loads.length, 1, "exactly one load, not one per batch");
    assert.match(loads[0], new RegExp(LISTED.replace(/[.]/g, "\\.")));
  } finally { globalThis.fetch = original; }
});

test("a quantisation suffix resolves to the model the provider lists", async () => {
  const loads = [];
  stub([{ key: LISTED, display_name: LISTED, loaded_instances: [] }], { loads });
  try {
    const result = await resolveTaggingModel(provider, `${LISTED}@q4_k_m`);
    assert.equal(result.ok, true, "the base id is what the provider lists");
    assert.equal(result.model, `${LISTED}@q4_k_m`, "the pass still sends what the config says");
  } finally { globalThis.fetch = original; }
});

test("an already-loaded model is not reloaded", async () => {
  const loads = [];
  stub([{ key: LISTED, display_name: LISTED, loaded_instances: [{ id: "inst-9" }] }], { loads });
  try {
    const result = await resolveTaggingModel(provider, LISTED);
    assert.equal(result.ok, true);
    assert.equal(result.loaded, true);
    assert.equal(loads.length, 0);
  } finally { globalThis.fetch = original; }
});

test("an unlisted model is refused with the ids the provider has", async () => {
  stub([{ key: LISTED, display_name: LISTED, loaded_instances: [] }]);
  try {
    const result = await resolveTaggingModel(provider, "llama-that-is-not-there");
    assert.equal(result.ok, false);
    assert.deepEqual(result.listed, [LISTED]);
    assert.match(result.error, /llama-that-is-not-there/);
    assert.match(result.error, new RegExp(LISTED.replace(/[.]/g, "\\.")), "the message names what it has");
  } finally { globalThis.fetch = original; }
});

test("an unreachable provider warns instead of refusing", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const result = await resolveTaggingModel(provider, LISTED);
    assert.equal(result.ok, true, "unreachable is the first completion's failure to report");
    assert.match(result.warning, /unreachable/i);
  } finally { globalThis.fetch = original; }
});
