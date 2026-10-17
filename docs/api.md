# HTTP API

`skyhook serve` (default `http://localhost:4173`) exposes a JSON API over Node's
built-in HTTP server — zero framework, CORS open. It's the same API the web GUI and
remote peers use, so anything the GUI can do, `curl` can too.

## Auth

When `remote.token` (or `SKYHOOK_REMOTE_TOKEN`) is set, every **POST** is rejected
unless it carries `Authorization: Bearer <token>`. GETs stay open. With no token the
API is fully open — fine for localhost, not for a LAN or the internet.

## Endpoints

### Seeders & scheduling

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ ok, seeders, scheduled, due, errors }` |
| GET | `/api/status` | Summary + due list |
| GET | `/api/seeders` | All seeders (`?filter=`, `?tier=news\|evergreen`, `?scheduled=1`) |
| GET | `/api/seeders/:source` | One seeder |
| GET | `/api/categories` | Category + subcategory list |
| GET | `/api/due` | Seeders due now |
| GET | `/api/history/:source` | Recent runs |
| POST | `/api/run` | `{ sources: [], parallel? }` |
| POST | `/api/schedule` | `{ source, cadence?, isNews?, maxAgeDays?, node? }` |
| POST | `/api/enable` | `{ source, cadence? }` |
| POST | `/api/disable` | `{ source }` |
| POST | `/api/seeders/preview` | Preview metadata for a new seeder |
| POST | `/api/seeders/new` | Create a seeder |
| POST | `/api/seeders/delete` | `{ source }` |

### Runtime & logs

| Method | Path | Description |
|---|---|---|
| GET | `/api/running` | `{ running, batch: { total, completed, remaining, etaMs } }` |
| GET | `/api/logs/:source` | Tail a live log (`?tail=N`) |
| POST | `/api/stop` | `{ source? }` — stop one or all runs |
| GET | `/api/timer` | Current timer plan |
| POST | `/api/timer` | Regenerate `.skyhook/skyhook-seed.timer` |

### Staging, analytics & curation

| Method | Path | Description |
|---|---|---|
| GET | `/api/staged` | Staged rows (`?source=`) |
| POST | `/api/staged/import` | `{ rows }` — import from a peer (needs `allowRemote`) |
| GET | `/api/stats` | Analytics (`?source=`) — `total`, `seeders`, `bySource` / `byCategory` / `bySubcategory` / `byLanguage` |
| GET | `/api/cache` | Staged + discovery cache listing |
| POST | `/api/cache/prune` | `{ filter, soft? }` — delete staged URLs |
| POST | `/api/cache/clear` | `{ source, kind? }` — clear staged (`kind:"discovery"`) |
| POST | `/api/push` | Push staged results → storage |

### Pipeline & tagging

| Method | Path | Description |
|---|---|---|
| GET | `/api/pipeline` | Offline pipeline status |
| POST | `/api/pipeline/:kind` | Run a pipeline job (`tag`, `push`, or any `pipeline.jobs` key) |
| GET | `/api/tagging/missing` | Counts of URLs missing category/subcategory/tags/content-type/quality/attributes |
| GET | `/api/tagging/models` | `{ models, errors, configured, provider }` — probe the active platform for downloaded models |
| POST | `/api/tagging/models/load` | `{ model, provider? }` — unload any loaded model, then load the target (LM Studio) |
| POST | `/api/tagging/run` | `{ task, model?, provider?, minTags? }` — launch a targeted LLM gap-filling pass (loads model first if needed) |

### Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Node settings (id, allowRemote, peers, tagging platform) |
| POST | `/api/settings` | `{ allowRemote?, taggingPlatform? }` — toggle node mode or select the active LLM platform |
