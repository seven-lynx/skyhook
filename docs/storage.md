# Storage Adapters

Skyhook writes discovered URLs through a pluggable **`StorageAdapter`**. Pick one
in `skyhook.config.json` → `storage.provider`.

## Providers

| Provider | Needs | Best for |
|---|---|---|
| `stage` (default) | nothing | offline JSONL staging (air-gapped / test runs) |
| `sqlite` | nothing (local) | fully self-contained local database |
| `supabase` | `url` + `serviceRoleKey` | hosted Postgres via Supabase |
| `postgres` | (fast-follow) | direct Postgres connection |

## schema.json — field mapping

Each adapter maps Skyhook's **canonical fields** onto your table/columns:

```json
{
  "table": "links",
  "conflictKey": "url",
  "columns": {
    "url": "url",
    "title": "title",
    "description": "description",
    "og_image_url": "image_url",
    "category_id": "category_id",
    "subcategory_id": "subcategory_id",
    "source": "source",
    "language": "language",
    "published_at": "published_at",
    "seeder_score": "seeder_score"
  },
  "extra": { "approved": true }
}
```

- `table` — the table to write to.
- `conflictKey` — unique column used for upsert dedup.
- `columns` — canonical field → **your** column name. Unmapped fields are dropped.
- `extra` — fixed values merged into every row (e.g. `approved: true`).

## Supabase

```json
{
  "storage": {
    "provider": "supabase",
    "url": "https://YOUR_PROJECT.supabase.co",
    "serviceRoleKey": "sb_secret_…",
    "schemaFile": "config/schema.json"
  }
}
```

Credentials may also come from `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in
`.env` (they override config). Uses the service-role key (bypasses RLS).

## SQLite

```json
{ "storage": { "provider": "sqlite", "dbFile": ".skyhook/skyhook.db" } }
```

The table is created automatically from `schema.json` columns (all TEXT, with the
conflict key UNIQUE). No external service needed.

## Stage (default)

Writes one JSONL file per `source` into `stagedDir` (default `.skyhook/staged`),
idempotent by URL. Pull the files to a machine with DB access to `push` later.
