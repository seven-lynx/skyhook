# 🛰 Skyhook

**Self-hosted content seeder.** Discover URLs from across the web, enrich them,
optionally tag them with a local or remote LLM, and push them into *your own*
database.

A *skyhook* is a tether that reaches up and pulls things in — Skyhook's seeders
reach out across the web and beam content down into your database.

## What it does

- **Discover** — a 9-tier discovery chain (RSS/Atom, JSON Feed, sitemap,
  WordPress REST, Wayback CDX, RSS autodiscovery, archive scraping, headless
  browser) finds article URLs for a site.
- **Enrich** — normalise URLs, drop storefronts, check liveness, fetch
  Open-Graph metadata, gate on title quality.
- **Tag (optional)** — classify each item into your category taxonomy and assign
  controlled tags using a local (Ollama, LM Studio, llama.cpp) or remote
  (OpenAI, Anthropic, Groq, …) model, with an editable prompt and vocabulary.
- **Push** — write the result into your own database via a pluggable storage
  adapter (Supabase, Postgres, SQLite, or offline JSONL staging).
- **Manage** — a CLI, terminal UI, and web GUI for listing seeders, scheduling
  them, and watching runs live.
- **Curate** — inspect and delete collected URLs per seeder / category / date
  *before* tagging (soft-delete to trash, reversible).
- **Analyse** — totals and percentages by seeder, category, subcategory, and
  language.
- **Multi-node** — run seeders on a Pi and a PC, toggle the Pi into a worker,
  and merge results between them with URL dedup.

## Status

**v0.2 — multi-node + curation + analytics.**

- ✅ **Core** (`src/core/seed.js`) + **engine** (`src/engine/seeder-engine.js`) ported and
  de-coupled from the original host.
- ✅ **Adapters** — storage (Supabase / SQLite / stage), categories, tagging, log.
- ✅ **Multi-node** — node identity, remote toggle, peer routing, sync/merge.
- ✅ **Curation + analytics** — `cache` / `stats` commands + API.
- ⏳ **GUI tabs** for Settings / Curation / Stats (fast-follow; CLI + API cover them today).

## Quick start

```bash
# install
git clone https://github.com/seven-lynx/skyhook.git
cd skyhook
npm install

# list / run / schedule (works offline in "stage" mode)
node bin/skyhook.js list
node bin/skyhook.js run example
node bin/skyhook.js serve          # web GUI + JSON API on :4173

# curation + analytics
node bin/skyhook.js stats                      # totals + percentages
node bin/skyhook.js cache list                 # staged + discovery cache
node bin/skyhook.js cache prune --source example --before 2026-01-01

# multi-node (Pi ⇄ PC)
node bin/skyhook.js settings                   # view node id / allowRemote
node bin/skyhook.js settings allow-remote on   # toggle the Pi into a worker
node bin/skyhook.js sync pull pi               # merge the Pi's results (PC)
node bin/skyhook.js push                       # push merged staged → storage
```

Docs: [quickstart](docs/quickstart.md) · [authoring seeders](docs/authoring-seeders.md) · [storage](docs/storage.md) · [tagging](docs/tagging.md) · [multi-node](docs/multi-node.md)

## Layout

```
src/
├─ core/          # discovery chain + enrich pipeline
│  ├─ staged.js     # staged JSONL helpers (read/merge/filter/group)
│  ├─ sync.js       # merge Pi ⇄ PC + push to storage
│  ├─ analytics.js  # totals + percentages
│  ├─ data.js       # cache/curation (prune, trash, clear discovery)
│  ├─ settings.js   # runtime-mutable settings (allowRemote toggle)
│  └─ remote.js     # peer routing + HTTP client
├─ engine/        # discovery, schedule, run, history, create/delete
├─ interfaces/    # CLI, TUI, HTTP API, GUI
├─ adapters/
│  ├─ storage/    # supabase / sqlite / stage
│  ├─ categories/ # categories.json → id map
│  ├─ tagging/    # LLM model detection + tag()
│  └─ log/        # JSONL run log
└─ config.js      # single config loader (+ node / remote / settings)
config/           # example categories.json, schema.json, prompt, vocab
```

## License

MIT — see [LICENSE](LICENSE).
