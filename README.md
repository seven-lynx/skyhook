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
- **Manage** — a CLI, terminal UI, and a web GUI workbench (section rail and
  navigator, draggable panes, an inspector, a live log dock, `Ctrl/Cmd+K`) for
  listing seeders, scheduling them, and watching runs live.
- **Analyse** — totals and percentages by seeder, category, subcategory, and
  language.
- **Multi-node** — run seeders on a Pi and a PC, toggle the Pi into a worker,
  and merge results between them with URL dedup.
- **Offline pipeline** — pull untagged URLs from your DB into a local SQLite
  copy, tag offline, then upload tags/attributes/quality back.
- **Cloudflare bypass** — optional FlareSolverr integration for bot-protected
  sites, launched on demand and torn down after each run.
- **Desktop app** — optional: a Tauri window around the same server, with a bundled
  Node runtime, a tray menu, the scheduler while it runs, and signed in-place
  updates. Everything above works without it. See [desktop.md](docs/desktop.md).

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
> `github:seven-lynx/skyhook#v0.4.3` as a dependency. **On npm 12** add
> `--allow-git=all` to that install and then run
> `npm install-scripts approve better-sqlite3`, because npm 12 blocks git fetches
> and unapproved native builds by default; npm 11 and earlier need neither.

## Requirements

- **Node.js ≥ 22** (CI tests 22 and 24; the desktop installer bundles a Node 24 runtime).
- `npm install` works out of the box on Windows/macOS/Linux — no C++ toolchain
  required. `better-sqlite3` is pinned to **12.x** (v13 forces a source build on
  clean installs).
- The **headless-browser** tier is optional and off by default. Run
  `npx playwright install chromium` once to enable it.

## Cloudflare bypass (FlareSolverr)

Some sites (e.g. Product Hunt) sit behind Cloudflare and return 403 to plain
HTTP clients. Seeders opt in by passing `bypassCloudflare: true` to
`upsertUrls()` / `fetchWithRetry()` / `fetchOgMeta()`, or by calling
`resolveRedirect(url)` to follow a bot-blocked redirect.

Skyhook uses [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) as the
browser backend. It is **not assumed to be running** — Skyhook launches the
configured executable on demand and stops it when the run (or batch) finishes.

Enable it from the GUI / TUI **Settings**, or statically in `skyhook.config.json`:

```json
{
  "flaresolverr": {
    "enabled": true,
    "exePath": "C:\\tools\\flaresolverr\\flaresolverr.exe",
    "port": 8191,
    "maxTimeout": 60000
  }
}
```

- `exePath` set → Skyhook spawns the executable on demand and waits for
  "FlareSolverr is ready!".
- `exePath` empty → Skyhook assumes an instance is already listening on `port`
  (e.g. the Docker container).
- Disabled / missing → bypass is a no-op and everything behaves as before.

Env fallbacks: `FLARESOLVERR_ENABLED=1`, `FLARESOLVERR_EXE`, `FLARESOLVERR_URL`,
`FLARESOLVERR_PORT`.

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
| `tag` | Offline LLM tag worker (resumable; `--mode retag-add\|retag-replace`, `--retry-failed`, `--requeue-untagged`, `--reask-no-tags`) |
| `pull` / `upload` | Pull URLs into the offline DB / upload tags & attributes back |
| `settings` | View or toggle node settings (`allow-remote`) |
| `init` | Scaffold `skyhook.config.json`, `config/`, `seeders/`, `.skyhook/` |
| `tui` | Interactive terminal menu |
| `serve` | HTTP JSON API + web GUI (`--port` 4173, `--host` 127.0.0.1) |
| `app` | Open the GUI in a chromeless app-mode window (`--port` 0 = free port, Edge/Chrome `--app=`) |

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

- [Documentation index](docs/README.md) — every doc, with the status that says who it binds
- [Quickstart](docs/quickstart.md) — install, connect a database, schedule
- [Authoring seeders](docs/authoring-seeders.md) — write your own `seed-*.js`
- [Storage](docs/storage.md) — storage adapters + `schema.json` mapping
- [Tagging](docs/tagging.md) — LLM tagging + fill-the-gap tasks
- [Offline pipeline](docs/pipeline.md) — `pull` / `tag` / `upload`
- [Multi-node](docs/multi-node.md) — PC ⇄ Pi controller/worker pair
- [HTTP API](docs/api.md) — JSON API reference
- [Deployment](docs/deployment.md) — systemd timer + `init` scaffold
- [Desktop app](docs/desktop.md) — install, data location, tray, updates

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

**v0.4.3** — the operator console is a workbench: a section rail with a
per-section navigator, draggable panes (splitters, collapse to a head strip, `F6`
cycles regions), a selection-driven inspector charting the source's recent runs, a
log dock that follows the live run with an elapsed timer, a status bar, and
`Ctrl/Cmd+K` command palette — at WCAG AA contrast, with the inspector a sheet on a
tablet. `tag --requeue-untagged` converges instead of re-picking the same URLs
every pass, `tag` resolves the configured model against what the provider lists
before the first batch, and `tag --reask-no-tags` is the way back for rows the
model answered with no tag. Feed and page text is hardened where CodeQL reported
it, a pushed `v*` tag now starts the workflow that builds the desktop installer,
and the repo ships `.env.example`. The bundled runtime and CI move to Node 24 LTS
(CI also tests 22; `engines.node` is `>= 22`).

**v0.3.7** — the pipeline reports distinct tagged URLs (not the raw tag-row
count); the dashboard shows the LLM worker once with a task label
(LLM-Tagging, LLM-Fill-Categories, …); a single-instance guard (server registry
+ lock file) prevents two LLM workers at once; a new "Import into offline DB"
action pulls staged seeder JSONL into the offline DB so a running tagger picks
it up. Plus **v0.3.6** — pipeline page now shows the status cards (counts + grouped run
buttons) instead of bare job buttons; the tagging worker's "running" state is a
fresh heartbeat (no more stale "running" after a crash) and its log is written
to `logs/tagger.log` and linked from the dashboard; live-log header text is
truncated instead of overlapping buttons; clearing a source's staged results now
actually deletes its file. Plus **v0.3.5** — redesigned professional GUI (design
system, live-log page, mobile
bottom nav, accessibility pass), PWA icons from the new logo, curation
clear/prune fix, plus the v0.2.x pipeline: offline LLM tagging worker,
`pull`/`upload`, targeted gap-filling tasks, config-driven pipeline, Postgres
adapter, and the multi-node control plane.

## Questions about the code

[docs/README.md](docs/README.md) says what each document binds;
[DeepWiki](https://deepwiki.com/seven-lynx/skyhook) answers the other
kind of question - where a stage lives, why the discovery chain
short-circuits, how a storage adapter maps columns - with links back
to the files.

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/seven-lynx/skyhook)

## License

MIT — see [LICENSE](LICENSE).
