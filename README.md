# Skyhook

**Self-hosted content seeder** — discover URLs from across the web, enrich them,
optionally tag them with a local or remote LLM, and push them into *your own*
database.

Skyhook is a Node CLI and installable web GUI for turning the open web into a
curated, tagged, searchable link collection. It runs on your hardware, writes to
your database, and needs no cloud service in between.

```
discover ──▶ enrich ──▶ stage ──▶ curate ──▶ tag ──▶ push ──▶ your database
```

## Features

- **Discover** — a 5-tier chain (RSS/Atom → sitemap → Wayback CDX → RSS
  autodiscovery → headless browser) finds article URLs, with an adaptive
  short-circuit that skips lower tiers once ≥50 URLs are found.
- **Enrich** — normalise URLs, drop storefronts, liveness-check, fetch
  Open-Graph metadata, gate on title quality.
- **Stage & curate** — everything lands in local JSONL first; inspect and delete
  URLs per seeder / category / date *before* tagging or pushing (soft-delete to
  trash, reversible).
- **Tag (optional)** — classify items into your taxonomy and assign controlled
  tags using a local (Ollama, LM Studio, llama.cpp) or remote (OpenAI,
  Anthropic, Groq, …) model, with an editable prompt and vocabulary. Includes
  targeted "fill the gap" passes (category, subcategory, tags, content type,
  quality, attributes).
- **Push** — write results into your database through a pluggable adapter:
  Supabase, Postgres, SQLite, or offline JSONL staging.
- **Manage** — a CLI, terminal UI, and web GUI for listing seeders, scheduling
  them, and watching runs live.
- **Analyse** — totals and percentages by seeder, category, subcategory, and
  language.
- **Multi-node** — run seeders on a Pi and a PC, toggle the Pi into a worker,
  and merge results between them with URL dedup.
- **Offline pipeline** — pull untagged URLs from your DB into a local SQLite
  copy, tag offline, then upload tags/attributes/quality back.

## Quick start

```bash
git clone https://github.com/seven-lynx/skyhook.git
cd skyhook
npm install

# try it offline (stage mode — no database needed)
node bin/skyhook.js list
node bin/skyhook.js run example
node bin/skyhook.js serve            # web GUI + JSON API on http://localhost:4173

# scaffold a fresh project (config, config/, seeders/, .skyhook/)
node bin/skyhook.js init --provider sqlite
```

> **Not on npm.** Skyhook is distributed as a GitHub dependency — the `skyhook`
> name on npm belongs to an unrelated project. Install via clone, or add
> `github:seven-lynx/skyhook#v0.3.1` as a dependency.

## Requirements

- **Node.js ≥ 20** (CI runs Node 20).
- `npm install` works out of the box on Windows/macOS/Linux — no C++ toolchain
  required. `better-sqlite3` is pinned to **12.x** (v13 forces a source build on
  clean installs).
- The **headless-browser** tier is optional and off by default. Run
  `npx playwright install chromium` once to enable it.

## Commands

| Command | What it does |
|---|---|
| `list` / `status` | Show all seeders with schedule, last run, result, next run |
| `due` | List seeders due to run now |
| `run <q>…` | Run one or more seeders now |
| `run-due` | Run every seeder that is due |
| `schedule <q> [cadence]` | View or change cadence / tier / max age / node |
| `enable` / `disable` | Add / remove a seeder from the schedule |
| `history <q>` | Show a seeder's recent run history |
| `validate` | Check category/subcategory wiring (needs Supabase) |
| `emit-timer` | Regenerate the systemd timer unit |
| `stats` | Totals + percentages by seeder / category / subcategory / language |
| `cache` | Inspect / prune staged results and the discovery cache |
| `sync pull <peer>` | Merge a peer's staged results (Pi ⇄ PC, URL dedup) |
| `push` | Push staged results into storage |
| `tag` | Offline LLM tag worker (resumable; `--mode retag-add\|retag-replace`) |
| `pull` / `upload` | Pull URLs into the offline DB / upload tags & attributes back |
| `settings` | View or toggle node settings (`allow-remote`) |
| `init` | Scaffold `skyhook.config.json`, `config/`, `seeders/`, `.skyhook/` |
| `tui` | Interactive terminal menu |
| `serve` | HTTP JSON API + web GUI (`--port`, default 4173) |

Run `node bin/skyhook.js help <command>` for a command's flags.

## Storage adapters

| Provider | Needs | Best for |
|---|---|---|
| `stage` (default) | nothing | offline JSONL staging / air-gapped |
| `sqlite` | nothing | self-contained local database |
| `supabase` | `url` + `serviceRoleKey` | hosted Postgres |
| `postgres` | `connectionString` (or `POSTGRES_URL`) | direct Postgres |

See [storage](docs/storage.md) for the `schema.json` column mapping.

## Documentation

- [Quickstart](docs/quickstart.md) — install, connect a database, schedule
- [Authoring seeders](docs/authoring-seeders.md) — write your own `seed-*.js`
- [Storage](docs/storage.md) — storage adapters + `schema.json` mapping
- [Tagging](docs/tagging.md) — LLM tagging + fill-the-gap tasks
- [Offline pipeline](docs/pipeline.md) — `pull` / `tag` / `upload`
- [Multi-node](docs/multi-node.md) — PC ⇄ Pi controller/worker pair
- [HTTP API](docs/api.md) — JSON API reference
- [Deployment](docs/deployment.md) — systemd timer + `init` scaffold

## Project layout

```
src/
├─ core/                # discovery + enrich + staging + sync + analytics
│  ├─ seed.js             # seedRssWithFallbacks / seedWaybackCdx / upsertUrls
│  ├─ staged.js           # staged JSONL helpers
│  ├─ sync.js             # merge peers + push to storage
│  ├─ offline-pipeline.js # pull / upload offline tagging pipeline
│  ├─ analytics.js        # totals + percentages
│  ├─ data.js             # cache / curation
│  ├─ settings.js         # runtime settings (allowRemote)
│  └─ remote.js           # peer routing + HTTP client
├─ engine/              # discovery, schedule, run, history, create/delete
├─ interfaces/          # CLI, TUI, HTTP API, pipeline, GUI
├─ adapters/
│  ├─ storage/          # supabase / postgres / sqlite / stage
│  ├─ categories/       # categories.json → id map
│  ├─ tagging/          # model detection, tag(), offline worker, tasks
│  └─ log/              # JSONL run log
└─ config.js            # config loader (+ node / remote / settings)
config/                 # categories.json, schema.json, tags.json, prompts/
seeders/                # seed-example.js, seed-hackernews.js, seed-lobsters.js
systemd/                # skyhook-seed.service / .timer templates
test/                   # smoke tests (node --test)
```

## Status

**v0.3.1** — redesigned professional GUI (design system, live-log page, mobile
bottom nav, accessibility pass), PWA icons from the new logo, curation
clear/prune fix, plus the v0.2.x pipeline: offline LLM tagging worker,
`pull`/`upload`, targeted gap-filling tasks, config-driven pipeline, Postgres
adapter, and the multi-node control plane.

## License

MIT — see [LICENSE](LICENSE).
