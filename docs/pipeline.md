# Offline Tagging Pipeline

Status: **guide** — the offline `pull` / `tag` / `upload` loop against a local SQLite copy of the
production data.

The default flow is `stage → curate → tag → push`. The **offline pipeline** lets you
do the tagging (and the final push) against a **local SQLite copy** of your
production data — useful when the machine doing LLM passes has no direct access to
your database, or when you want to tune prompts and vocabulary without round-trips.

```
production DB ──pull──▶ offline SQLite ──tag──▶ local_url_* tables ──upload──▶ production DB
```

## Config

Add a `pipeline` block to `skyhook.config.json`:

```jsonc
{
  "pipeline": {
    "offlineDb": ".skyhook/offline.db",       // local SQLite copy of `urls` + tag tables
    "knownUrlsDb": ".skyhook/known-urls.db",  // dedup index of production URLs (optional)
    "status": "scripts/pipeline-status.mjs",  // optional script that prints status JSON
    "jobs": {                                 // optional: custom pipeline jobs for the GUI
      // "export": { "label": "Export", "command": ["scripts/export.mjs"], "danger": false }
    }
  }
}
```

| Key | Purpose |
|---|---|
| `offlineDb` | Local SQLite DB holding the `urls` table plus the `local_url_*` tagging tables |
| `knownUrlsDb` | Local dedup index of every URL already in production (defaults to `.skyhook/known-urls.db`) |
| `status` | Optional script that prints the pipeline status JSON shown in the GUI |
| `jobs` | Optional `{ key: { label, command: [script, ...args], danger?, llm? } }` map surfaced in the GUI |

> **Note:** `pull` and `upload` currently target **Supabase** (they use the
> service-role client). Set `storage.url` + `storage.serviceRoleKey` (or the
> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` env vars) first. The `tag` worker only
> needs the local `offlineDb` and a configured `tagging` provider.

### Run order, and the two commands that look interchangeable but are not

`pull` syncs the dedup index, pulls URLs, **and imports staged seeder JSONL** - the
import happens inside `pullOffline`, after the index sync. `pull --index-only` returns
before that step. So an `upload` placed directly after `--index-only` uploads no new
URLs at all, and a second `pull` pays for the full index re-scan twice.

```bash
skyhook pull      # index sync -> pull URLs -> import staged JSONL (moves files to staged/consumed/)
skyhook upload    # staged URLs into the target, local ids remapped to the target's
skyhook tag       # one pass: tags + attributes + quality per URL
skyhook upload    # the new tags/attributes/quality
```

An empty `staged/` directory proves nothing: the import renames each file into
`staged/consumed/`, so the directory empties before the upload runs. Count rows on the
far side instead.

## CLI

```bash
# 1. Sync the dedup index + pull untagged URLs into the offline DB
skyhook pull                    # untagged only (idempotent) + imports staged JSONL
skyhook pull --force            # pull everything, not just untagged
skyhook pull --index-only       # only (re)build the known-URLs dedup index
skyhook pull --max 500          # stop after N new rows

# 2. Tag offline (resumable via the local_url_tagged_by marker table)
skyhook tag                     # first pass: tag untagged URLs
skyhook tag --mode retag-add    # second pass: add more tags to already-tagged URLs
skyhook tag --mode retag-replace # second pass: replace existing tags
skyhook tag --retry-failed      # re-select only the rows a failed batch stranded
skyhook tag --requeue-untagged  # re-select URLs with zero tags it has not given up on (skips junk)
skyhook tag --reask-no-tags     # put the URLs it did give up on back to the model, once
skyhook tag --task fill-category # targeted gap-filling pass (see tagging.md)
skyhook tag --provider ollama --batch-size 50

# 3. Upload results back to storage
skyhook upload                  # staged URLs + tags/attributes/quality
skyhook upload --dry-run
```

## How it works

- **`pull`** syncs a `known_urls` dedup index (a full re-scan of the production
  `urls` table by primary key), then copies untagged URLs into the offline DB.
  Staged seeder output is imported and deduped against this index so you never tag
  a URL you already have.
- **`tag`** runs the offline LLM worker over the offline DB. It writes to
  `local_url_tags`, `local_url_attributes`, and `local_url_quality`, and resumes by
  skipping already-tagged URLs. Task mode (`--task`) targets a specific gap —
  missing category, subcategory, tags, content type, quality, or attributes — see
  [tagging.md](tagging.md).
- **`upload`** pushes staged URLs and any local tags / attributes / quality rows
  that haven't been marked `synced` back to storage.

## Tables (offline DB)

| Table | Contents |
|---|---|
| `urls` | Local copy of production URLs (plus `is_staged` for staged imports) |
| `local_url_tags` | Per-URL tags written by the worker |
| `local_url_attributes` | audience / content type / depth / tone / is_news |
| `local_url_quality` | url_type, quality_score, spam / parked / paywall flags, … |
| `local_url_tagged_by` | Resume markers (url_id + model source) |

Three of them carry a `synced` column, added on first upload: `0` (or NULL) means the
row has not been sent, and the upload flips it to `1` for exactly the rows it sent.
The upload pages by `rowid` keyset, so marking rows inside the loop cannot make it skip
its own backlog. `local_url_attributes` and `local_url_quality` use `INSERT OR REPLACE`
in the writer, which resets `synced` to its default - that is why a re-tagged row
re-uploads without any extra flag being set.

## GUI

The web GUI's **Pipeline** tab surfaces pipeline status (from `pipeline.status`, or a
built-in default), the fill-the-gap task runner, and the **Tagging Gaps** cards.
`POST /api/pipeline/:kind` launches pipeline jobs - see [api.md](api.md).

A **card action** is just a `kind` string that must resolve to a job. Three layers have
to agree, and a mismatch is a `404` from `POST /api/pipeline/:kind`:

| Layer | Where | What it contributes |
|---|---|---|
| status payload | `pipeline.status` script (or the built-in) | `cards[].actions[]` = the buttons drawn |
| job map | `pipeline.jobs` in config, or a built-in | `kind` → `{ label, command, danger?, llm? }` |
| CLI | `bin/skyhook.js` | the command the job spawns |

Built in, so a config with no `jobs` block still gets them:

| Button | Job key | Command |
|---|---|---|
| Retry N failed | `tag-retry-failed` | `skyhook tag --retry-failed` |
| Tag URLs with no tags | `tag-untagged` | `skyhook tag --requeue-untagged` |

The first also appears automatically whenever the status payload reports failures.

A job is treated as an **LLM job** (only one may run at a time, because they share one
model endpoint) when its command array contains `tag`, or when it sets `"llm": true`.

`pipeline.jobs` is a **config-to-process boundary**: the command string is executed, so it is
written only in `skyhook.config.json` — the owner's file. No HTTP body can supply one: the API
takes a `kind`, looks it up in that map, and answers `404` for a kind it does not know. Anything
that exposes job *editing* would be handing a command to an unauthenticated caller, which is why
it is out of scope (`30-optional-features`, *Exposure*).
A key name alone is not enough - a custom key must satisfy one of those two.

