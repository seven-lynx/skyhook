# Changelog

Release history, newest first. The README's **Status** paragraph describes the
current release; this file keeps every release, because that paragraph is
rewritten each time. Versions follow semver, entries follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Skyhook is not published to npm: a release is a git tag, a GitHub release and —
once the desktop track ships — a signed installer.

## [Unreleased]

### Added

- `.env.example` — the tracked list of every environment key `.env` may set,
  with no values in it, and a test that fails if one ever appears.
- A desktop application (Tauri + a bundled Node sidecar) on the desktop track,
  not yet released: it ships in `v0.5.0`.
- In-place updates for the desktop app: it checks `latest.json` on the Release once
  per launch behind a *Check for updates automatically* toggle, verifies the
  download's minisign signature and its signed version, then installs passively.
  Building the installer now needs `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `npm run desktop:dist` also writes
  `latest.json` beside the artifacts.
- `tag --reask-no-tags` — put the rows the model answered with no tag back to
  the model, once, after the prompt or vocabulary changed.

### Fixed

- `tag --requeue-untagged` now converges. A URL the model answers with no
  surviving tag is recorded as `:no-tags` instead of being offered again on
  every pass, so the tail reaches zero instead of re-buying the same URLs.
- `tag` resolves the configured model against what the provider lists before the
  first batch: an already-downloaded model is loaded, an id carrying a
  quantisation suffix (`…@q4_k_m`) resolves on its base id, and an id the
  provider does not have is refused with the ids it does have, rather than
  failing mid-run.

### Changed

- The bundled runtime and CI move to Node 24 LTS (CI also tests 22);
  `engines.node` is now `>= 22`. Node 20 reached end-of-life on 2026-03-24.

## [0.4.2]

### Fixed

- The upload path is lossless and idempotent: every emitted value is mapped
  through `tagging.enums` (booleans included), and all three upload loops page
  by `rowid` keyset instead of `LIMIT/OFFSET` — an offset over a predicate the
  loop itself cleared used to upload about half the backlog.
- `url_tags.source` is one configured value, and the staged-row existence check
  is batched.
- `tag --retry-failed` and `tag --requeue-untagged`, plus two GUI buttons, make
  stranded rows reachable without deleting resume markers.

### Changed

- One canonical pass fills tags, attributes and quality from a single model
  response, and the task prompts quote the same vocabulary as the writer.

## [0.4.1]

### Added

- LM Studio model management: list and load models, and `ensureModelLoaded`.

## [0.4.0]

### Added

- Cloudflare bypass tier (FlareSolverr), opt-in per seeder — for bot-protected
  sites that answer 403/503.
