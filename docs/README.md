# Skyhook Documentation

Status: **index** — the map of `docs/`. If a file is not listed here, it should not exist.

Pairs with: `README.md` (the front door), `src/config.js` (`DEFAULTS`, the real defaults), and
`src/interfaces/api-server.js` (the real route table).

Eight documents, one job each. Start at the row that matches what you are doing; do not read the
whole directory.

---

## Where to start

| I want to… | Read | Status |
|---|---|---|
| Install it, point it at a database, schedule it | [`quickstart.md`](quickstart.md) | guide |
| Write my own `seeders/seed-*.js` | [`authoring-seeders.md`](authoring-seeders.md) | guide |
| Choose a storage adapter, or map my table's columns | [`storage.md`](storage.md) | **contract** |
| Understand the LLM tagging stage and its prompts | [`tagging.md`](tagging.md) | reference |
| Tag offline against a local SQLite copy, then upload | [`pipeline.md`](pipeline.md) | guide |
| Run a PC and a Pi as controller and worker | [`multi-node.md`](multi-node.md) | guide |
| Build a client against the JSON API | [`api.md`](api.md) | **contract** |
| Scaffold a project, or schedule it with systemd | [`deployment.md`](deployment.md) | guide |
| Fix a run that stopped, stalled, or was rejected | [`troubleshooting.md`](troubleshooting.md) | runbook |
| Understand the pipeline end to end | [`../README.md`](../README.md) | overview |

## The status field

Every document opens with a `Status:` line under its title. The status says who the file binds,
which is what makes it safe to quote:

| Status | Means | If it is wrong |
|---|---|---|
| `contract` | Code outside this repo depends on it. Additive changes only. | Fix the doc and the code together |
| `reference` | Describes behaviour, providers and configuration. | Fix the file against `src/config.js` |
| `guide` | Step-by-step for a human at a keyboard. | Fix the file; a command that does not run is a bug |
| `runbook` | What to do when something has already gone wrong. | Fix the file |
| `index` | This page. Navigation only. | Add the missing row |

The `**vX.Y.Z**` line in the root `README.md` tracks `package.json`'s `version`. Both change in the
same commit, or neither does; `check_plans.py` rule `W15` warns while they disagree.

## Rules for this directory

1. **One job per file.** A document that describes both the wire contract and the install steps
   will be wrong about one of them.
2. **A new file needs a row in the table above**, in the same commit. An unlisted document is
   unreachable, and `check_rules.py` rule `RW4` warns about one.
3. **No document may point outside the repository.** Plans, notes and scratch work live in a
   gitignored local tree; a tracked file that cites it is broken for every reader but the author,
   and rule `W13` fails on one.
4. **Facts come from the tree.** Every command, key and default here must be checkable:
   `src/config.js` for defaults, `src/interfaces/api-server.js` for routes, `bin/skyhook.js` for
   commands, `package.json` for `engines` and dependencies.
5. **Delete, do not deprecate.** A guide for a feature that no longer exists is a second source of
   truth; removals are recorded in the README's Status paragraph, which is the only history this
   repo keeps.
6. **Every document opens with a `Status:` line.** A document without one is quoting nothing.

## Outside `docs/`

| File | Holds |
|---|---|
| `README.md` | what the project is, the command table, the feature list, the Status paragraph |
| `src/config.js` | `DEFAULTS` — the defaults every install starts from |
| `config/categories.json` | the taxonomy: 8 pillars, 98 subcategories |
| `config/schema.json` | the canonical-field → column mapping for a user's database |
| `config/prompts/` | the gap-filling prompts, one per task |
| `seeders/` | `seed-example.js` and the user's own seeders |
| `systemd/` | the service and timer templates `emit-timer` regenerates |
