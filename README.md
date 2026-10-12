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

## Status

**v0.1 — in active extraction.**

- ✅ **Core** (`src/core/seed.js`) + **engine** (`src/engine/seeder-engine.js`) ported and
  de-coupled from the original host.
- ✅ **Adapters** — storage (Supabase / SQLite / stage; Postgres fast-follow), categories, tagging, log.
- ⏳ **Interfaces** (CLI / TUI / HTTP API / GUI) — ported, ready to use.

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
```

Docs: [quickstart](docs/quickstart.md) · [authoring seeders](docs/authoring-seeders.md) · [storage](docs/storage.md) · [tagging](docs/tagging.md)

## Layout

```
src/
├─ core/          # discovery chain + enrich pipeline
├─ engine/        # discovery, schedule, run, history, create/delete
├─ interfaces/    # CLI, TUI, HTTP API, GUI   (Phase 4)
├─ adapters/
│  ├─ storage/    # supabase / postgres / sqlite / stage
│  ├─ categories/ # categories.json → id map
│  ├─ tagging/    # LLM model detection + tag()
│  └─ log/        # JSONL run log
└─ config.js      # single config loader
config/           # example categories.json, schema.json, prompt, vocab
```

## License

MIT — see [LICENSE](LICENSE).
