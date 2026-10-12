/**
 * pipeline.js — offline pipeline jobs (stage → import → tag → push).
 *
 * Minimal, database-agnostic version. Reports job status and lets the GUI/TUI
 * launch the LLM `tag` job through the tagging adapter. A host can inject a
 * richer pipeline (offline-DB export, provider push) via its own overlay.
 */

export function pipelineStatus() {
  return {
    jobs: [
      { key: "tag", label: "LLM tag", status: "idle" },
      { key: "push", label: "Push to storage", status: "idle" },
    ],
    note: "LLM tagging via the tagging adapter (configure providers to enable).",
  };
}

export function startPipelineJob(kind) {
  // Placeholder — the tag job is wired in a later pass against staged rows.
  return kind === "tag" || kind === "push" ? { key: kind, alreadyRunning: false } : null;
}
