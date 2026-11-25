# Troubleshooting

Status: **runbook** — what to do when a run has already gone wrong.

Every section is symptom, cause, one command. Nothing here changes behaviour; if a
command below reveals a bug, the bug is the thing to fix, not the workaround.

---

## The worker says another tagger is already running

**Symptom** — `skyhook tag` exits immediately with
`another tagger is already running (lock file is fresh)`.

**Cause** — `pipeline.offlineDb`'s directory holds a `.tagger.lock`. It is written on
start and removed on exit; a worker killed with its terminal takes it with it, so a
*fresh* lock means a real process. A lock older than 15 minutes is reclaimed
automatically (`src/adapters/tagging/offline-worker.js`, `TAG_LOCK_STALE_MS`).

**Command** — check `skyhook status` first. If nothing is running and the lock is older
than 15 minutes, delete `<offlineDb dir>/.tagger.lock` by hand. Ask whether a second
terminal, the GUI or a scheduled task holds it before deleting anything.

## The worker starts but every batch fails

**Symptom** — `[fail] Batch 1 failed (1 consecutive): …` and no rows are written.

**Cause** — the provider is unreachable, or `tagging.model` names a model the endpoint
does not serve. `skyhook tag` does **not** load a model: LM Studio must already have one
loaded, or be configured to load just-in-time. The similar-looking 400 whose body
mentions `system` is handled automatically (the prompt is merged into a user message and
retried).

**Commands**

```bash
curl http://localhost:1234/api/v1/models   # what the endpoint actually serves
skyhook serve                              # GUI → Pipeline → Detect models → Load model
```

The id in `/v1/models` and the `@quantisation` suffix LM Studio accepts are not always
the same string; use an id the listing shows.

## The worker pauses by itself

**Symptom** — `[pause] model may have unloaded. Check LM Studio.`

**Cause** — `Model unloaded` in the error text, or five consecutive batch failures. The
worker stops on purpose rather than marking the whole corpus failed.

**Command** — reload the model and re-run the same command. It resumes from the marker
table, so nothing is re-tagged.

## Nothing is left in the queue, but URLs clearly have no tags

**Symptom** — `skyhook tag` reports a remaining count of 0 while the corpus is visibly
untagged.

**Cause** — the queue selects by the `local_url_tagged_by` marker, not by the presence of
tags. Before v0.4.2 the worker marked a whole batch even when the model answered only
part of it, so those URLs carry a marker and zero tags.

**Command**

```bash
skyhook tag --requeue-untagged
```

That select re-reads URLs with no `local_url_tags` rows regardless of the marker, and
skips junk when `local_url_quality` is present. Markers are never deleted, so resume
history survives.

## Failed batches are never retried

**Symptom** — the status payload reports failed rows that a normal run never picks up.

**Cause** — a failed batch writes `modelSource:failed`, and the ordinary queue excludes
both the base source and the `:failed` variant. Before v0.4.2 nothing re-selected them.

**Command**

```bash
skyhook tag --retry-failed
```

A successful retry deletes that row's `:failed` marker, so the count can go down.

## An upload is rejected by the database

**Symptom** — `Upload error: … invalid input syntax`, or a CHECK constraint violation
from `url_attributes` / `url_quality`.

**Cause** — the local DB holds a value the target schema does not accept. v0.4.2 maps
every emitted value through `tagging.enums` before sending, so this is only reachable
when the enum table and the target schema disagree.

**Commands**

```bash
skyhook upload --dry-run          # which values would be dropped, writing nothing
node --test test/enums.test.mjs   # the hardware-free reproduction
```

If the table is right and the target is wrong, narrow `tagging.enums.values` in
`skyhook.config.json`: the mapper then drops the value and counts it instead of sending
it.

## An upload says it sent N rows but the target has fewer

**Symptom** — the log reports `… tags uploaded (K skipped: slug not in the target
vocabulary)`.

**Cause** — the local tag list and the target `tags` table disagree. Skyhook never
invents a tag on the far side; it drops the row and counts it.

**Command** — reconcile the vocabularies, then re-run `skyhook upload`. The expected
upload count is `local_url_tags` joined to the target `tags`, never the raw local row
count.
