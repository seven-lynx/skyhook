# Changelog

Release history, newest first. The README's **Status** paragraph describes the
current release; this file keeps every release, because that paragraph is
rewritten each time. Versions follow semver, entries follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Skyhook is not published to npm: a release is a git tag, a GitHub release and —
once the desktop track ships — a signed installer.

## [Unreleased]

### Fixed

- The desktop shell reports the version it is: `src-tauri/Cargo.toml` stayed at `0.4.2` while the
  release was `0.5.0`, and the updater's up-to-date line prints `env!("CARGO_PKG_VERSION")` from
  that manifest, so an installed 0.5.0 build said `up to date (0.4.2)` (#56).
  `test/desktop-guard.test.mjs` now fails when `package.json`, `tauri.conf.json` or
  `Cargo.toml` disagrees with the others, and `docs/deployment.md` names the fourth.

## [0.5.0]

### Added

- A desktop application (Tauri + a bundled Node sidecar): a WebView2 window
  around the same server, the run schedule owned in-app on Windows, and a sidecar
  the shell supervises and stops with the window. State lives in the app data
  directory the shell passes to the sidecar, not the launch directory.
- In-place updates for the desktop app: it checks `latest.json` on the Release once
  per launch behind a *Check for updates automatically* toggle, verifies the
  download's minisign signature and its signed version, then installs passively.
  Building the installer now needs `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `npm run desktop:dist` also writes
  `latest.json` beside the artifacts.

### Fixed

- `GET /api/due`, `/api/status` and `/api/health` no longer report a seeder that is
  already running as due, and `POST /api/run` answers `skippedRunning` instead of
  starting a second child for it.
- A browser page on another origin can POST with its token: the CORS preflight now
  names `Authorization` and `x-skyhook-token`, not just `Content-Type`.
- A request path ending in a long run of slashes is trimmed by a loop instead of a
  right-anchored regex, so it cannot be made to backtrack quadratically.
- `skyhook serve` warns on stderr when no `skyhook.config.json` sits beside the
  working directory, naming that directory and the path it looked for. A run started
  from the wrong `WorkingDirectory` used to boot on the defaults and answer with the
  two built-in cards, with nothing in the log to say why.
- `tag --max N` bounds the URLs tagged in *that run* rather than the lifetime
  checkpoint, so `--max 1` on a database tagged before the flag no longer exits
  before tagging anything, and `--max N` no longer processes `N - checkpoint`
  rows. The run summary reads `N processed this run (M lifetime)`; the returned
  `processed` is still the lifetime total, with `processedThisRun` beside it.
- A failing CLI command prints one line and exits 1 instead of an unhandled-rejection
  stack. `SKYHOOK_DEBUG=1` keeps the stack for debugging, and the taxonomy is no longer
  read at import, so `skyhook help` works next to a `skyhook.config.json` that does not
  parse.
- Test fixtures are `gitignore`d, and the config suite removes its `.tmp-*` root in an
  `after()` hook instead of a trailing line a red test skips: 84 empty `.tmp-config-*`
  directories had accumulated in one checkout.
- The generated icons composite on `--bg` read out of `styles.css` rather than a
  hardcoded navy, and the 96 px header logo gets that backdrop too: it was a white tile
  on the dark bar. A test now fails if the stylesheet, the manifest and `index.html`
  disagree about the colour.
- The Settings remote-control toggle issues one request per click again: its listener was
  bound on every visit to the section, so four visits turned one click into four
  `POST /api/settings` calls, each carrying the state its own render had seen.
- The dashboard's empty states use the shared `.empty` rule instead of an inline
  padded paragraph.
- The console's due panel and its two due counters no longer offer a Run button for a
  seeder that is already running.

## [0.4.3]

### Added

- The web GUI is an operator workbench: a section rail with a per-section
  navigator, a draggable pane layout (splitters, collapse to a head strip, `F6`
  cycles regions), a selection-driven inspector that charts the source's recent
  runs and offers the common actions, a log dock that follows the live run with
  an elapsed timer, and a status bar. Above 720 px a `#/log/:source` link is the
  dock's deep link; between 721 and 1180 px the inspector becomes a sheet.
- `Ctrl/Cmd+K` opens a command palette over views, actions and seeders, with the
  same confirm-and-run path as the buttons.
- `.env.example` — the tracked list of every environment key `.env` may set,
  with no values in it, and a test that fails if one ever appears.
- `tag --reask-no-tags` — put the rows the model answered with no tag back to
  the model, once, after the prompt or vocabulary changed.
- Focus rings, named landmarks and a contrast pass bring the console to WCAG AA
  (26 measured pairs), and icons carry one base size so an unsized `<svg>` can no
  longer take over the row it sits in.

### Fixed

- Feed and page text is hardened where CodeQL reported it (#37): a feed title or
  description is stripped until no tag remains, an HTML entity decodes once
  (`&amp;lt;` stays the text `&lt;` instead of becoming `<`), a peer URL loses
  its trailing slashes without a backtracking regex, and the `tagging` job's
  console line takes its task name as an argument rather than as a format
  string.
- A pushed `v*` tag now starts the CI workflow that builds the desktop installer.
  `ci.yml`'s `on.push` listed branches only, so the tag-only `desktop` job — guarded
  to `refs/tags/v` — could never fire and a release attached no artifacts (#35).
- `tag --requeue-untagged` now converges. A URL the model answers with no
  surviving tag is recorded as `:no-tags` instead of being offered again on
  every pass, so the tail reaches zero instead of re-buying the same URLs.
- `tag` resolves the configured model against what the provider lists before the
  first batch: an already-downloaded model is loaded, an id carrying a
  quantisation suffix (`…@q4_k_m`) resolves on its base id, and an id the
  provider does not have is refused with the ids it does have, rather than
  failing mid-run.
- A dashboard row's result text renders a double-encoded minus as a minus.

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
