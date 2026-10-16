# Skyhook Quickstart

Self-hosted content seeding — discover URLs, enrich them, optionally tag them with
an LLM, and push them into your own database.

## 1. Install

```bash
git clone https://github.com/seven-lynx/skyhook.git
cd skyhook
npm install
```

> Skyhook isn't published to npm (the `skyhook` name is taken by an unrelated
> project). To use it as a dependency elsewhere, install from GitHub instead:
> `npm install github:seven-lynx/skyhook#v0.3.5`.

## 2. Try it (offline, no database)

Skyhook ships with example seeders and works out of the box in **stage** mode
(writes to local JSONL, no database required):

```bash
node bin/skyhook.js list           # see the example seeders
node bin/skyhook.js run example    # run the example seeder (offline staging)
node bin/skyhook.js tui            # interactive terminal menu
node bin/skyhook.js serve          # web GUI + JSON API at http://localhost:4173
```

The headless-browser discovery tier is optional and off by default. If you want
it, install its browser once: `npx playwright install chromium`.

## 3. Connect your database

Create a `skyhook.config.json` at the repo root to pick a storage provider (the
file is gitignored, so a fresh clone starts without one). See
[docs/storage.md](storage.md) for the full mapping. Example (Supabase):

```json
{
  "storage": {
    "provider": "supabase",
    "url": "https://YOUR_PROJECT.supabase.co",
    "serviceRoleKey": "sb_secret_...",
    "schemaFile": "config/schema.json"
  }
}
```

Or set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in `.env` (they override config).

## 4. Schedule

```bash
node bin/skyhook.js enable hackernews --cadence daily
node bin/skyhook.js run-due          # run everything due now
node bin/skyhook.js emit-timer       # regenerate the systemd timer unit
```

## 5. Tag with an LLM (optional)

Configure your local or remote model in `skyhook.config.json` → `tagging`, then
use the GUI's **Pipeline → Tagging** card (or `detectModels()` programmatically).
See [docs/tagging.md](tagging.md).

## 6. Offline tagging pipeline (optional)

Pull untagged URLs out of your database into a local SQLite copy, tag them
offline, and upload tags/attributes/quality back. See
[docs/pipeline.md](pipeline.md):

```bash
node bin/skyhook.js pull             # pull untagged URLs → offline SQLite DB
node bin/skyhook.js tag              # run the offline LLM tag worker
node bin/skyhook.js upload           # push staged URLs + tags back to storage
```

## Layout

```
seeders/            # your seeder scripts (seed-*.js)
config/             # categories.json, schema.json, tagging prompt + vocab
src/                # core, engine, adapters, interfaces
systemd/            # skyhook-seed.service/.timer templates
```

## More docs

[authoring seeders](authoring-seeders.md) · [storage](storage.md) ·
[tagging](tagging.md) · [pipeline](pipeline.md) · [multi-node](multi-node.md) ·
[API](api.md) · [deployment](deployment.md)
