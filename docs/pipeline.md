# Offline Tagging Pipeline

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
| `jobs` | Optional `{ key: { label, command: [script, ...args], danger? } }` map surfaced in the GUI |

> **Note:** `pull` and `upload` currently target **Supabase** (they use the
> service-role client). Set `storage.url` + `storage.serviceRoleKey` (or the
> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` env vars) first. The `tag` worker only
> needs the local `offlineDb` and a configured `tagging` provider.

## CLI

```bash
# 1. Sync the dedup index + pull untagged URLs into the offline DB
skyhook pull                    # untagged only (idempotent)
skyhook pull --force            # pull everything, not just untagged
skyhook pull --index-only       # only (re)build the known-URLs dedup index
skyhook pull --max 500          # stop after N new rows

# 2. Tag offline (resumable via the local_url_tagged_by marker table)
skyhook tag                     # first pass: tag untagged URLs
skyhook tag --mode retag-add    # second pass: add more tags to already-tagged URLs
skyhook tag --mode retag-replace # second pass: replace existing tags
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

## GUI

The web GUI's **Pipeline** tab surfaces pipeline status (from `pipeline.status`, or a
built-in default), the fill-the-gap task runner, and the **Tagging Gaps** cards.
`POST /api/pipeline/:kind` launches pipeline jobs — see [api.md](api.md).
