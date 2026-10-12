# Multi-node (PC ⇄ Pi)

Skyhook runs identically on a PC and a Raspberry Pi. Two nodes can be wired into
a **controller + worker** pair: the PC owns the schedule and the canonical
database; the Pi (when toggled into *worker* mode) runs assigned seeders and
ships results back. Until you toggle it, the Pi is just a normal standalone
seeder manager.

## Concepts

- **Node id** — `node.id` in `skyhook.config.json`. Identifies this machine
  (`"pc"`, `"pi"`, …). Defaults to `"local"`.
- **allowRemote** — a runtime toggle (stored in `.skyhook/settings.json`, not the
  static config). When **OFF** the node is standalone; when **ON** it accepts
  remote control (it becomes a worker).
- **Peers** — `remote.peers` lists the other nodes this one can talk to, each
  with an `id` and `url` (their `skyhook serve` address).
- **Token** — `remote.token` (or `SKYHOOK_REMOTE_TOKEN`) is the shared secret.
  When set, every mutating API request must send it as
  `Authorization: Bearer <token>`.

## Config example (PC — the master)

```jsonc
{
  "node": { "id": "pc" },
  "remote": {
    "token": "change-me",
    "peers": [ { "id": "pi", "url": "http://raspberrypi.local:4173" } ]
  },
  "storage": { "provider": "supabase", "schemaFile": "config/schema.json" }
}
```

## Config example (Pi — the worker)

```jsonc
{
  "node": { "id": "pi" },
  "remote": {
    "token": "change-me",
    "peers": [ { "id": "pc", "url": "http://pc.local:4173" } ]
  }
  // storage stays "stage" (default) — the Pi only stages, it has no DB.
}
```

## The toggle

```bash
skyhook settings                       # view node id / allowRemote / peers
skyhook settings allow-remote on       # Pi: become a worker
skyhook settings allow-remote off      # back to standalone
```

The same switch is exposed as `POST /api/settings { "allowRemote": true }` for
the GUI.

## Assigning seeders to a node

A manifest entry carries a `node` field naming the peer that runs it. On the PC:

```bash
skyhook schedule nyt weekly --node pi        # NYT runs on the Pi
skyhook schedule guardian weekly             # no --node → runs locally
```

When you run or run-due on the PC, any seeder assigned to a peer is forwarded to
that peer's API automatically; the rest run locally. On the Pi, `run-due --node pi`
runs only the seeders assigned to it (its own timer does this).

## Merging results (dedup by URL)

The Pi stages locally (JSONL in `.skyhook/staged/`). The PC pulls and merges:

```bash
skyhook sync pull pi        # GET pi:/api/staged → merge into local staged (URL dedup)
skyhook stats               # see the combined set
skyhook push                # replay merged staged → storage (dedup again on conflict key)
```

Dedup is **first-writer-wins** by URL (matching the storage adapter's
`ignoreDuplicates` behaviour).

## Curating before tagging

The pipeline is `stage → curate → tag → push`. Between staging and tagging you
can delete URLs per seeder / category / subcategory / date:

```bash
skyhook cache list          # staged (per source) + discovery cache
skyhook cache prune --source nyt --before 2026-01-01
skyhook cache prune --category SCIENCE --hard      # --hard = no trash copy
skyhook cache clear nyt                              # clear a source's staged rows
skyhook cache clear nyt --discovery                  # force re-fetch on next run
```

Deletions are **soft by default** (archived to `.skyhook/trash/`), so they can be
restored. API: `GET /api/cache`, `POST /api/cache/prune`, `POST /api/cache/clear`.

## Analytics

```bash
skyhook stats               # total URLs, per-seeder %, per-category %, subcategory, language
skyhook stats --source nyt  # one seeder
```

API: `GET /api/stats`. Returns `total`, `seeders`, and sorted `bySource` /
`byCategory` / `bySubcategory` / `byLanguage` arrays with `count` + `pct`.

## LLM tagging on the Pi

The Pi has no local model. Tagging is endpoint-driven (HTTP only) — point
`tagging.providers` at the PC's Ollama or a cloud endpoint and it never attempts
to load a model locally:

```jsonc
{
  "tagging": {
    "providers": [ { "id": "ollama", "baseUrl": "http://pc.local:11434" } ],
    "model": "llama3.1"
  }
}
```

Run the tag job via `POST /api/pipeline/tag` (or the GUI's Pipeline tab).

## Security note

With no `remote.token`, the HTTP API is open (local development default). Set a
token before exposing `skyhook serve` on a LAN or the internet.
