# Deployment & Scheduling

Status: **guide** — scaffolding with `init`, the app window `app` opens, the systemd timer
`emit-timer` regenerates, the development path for the optional desktop shell, and the pointer to
the multi-node setup.

## Scaffolding a project

`skyhook init` creates a self-contained project in the current directory:

```
skyhook.config.json     # storage provider + paths
config/
├─ categories.json      # 8 pillars / 98 subcategories
└─ schema.json          # field mapping for your DB
seeders/
└─ seed-example.js      # template to copy
.skyhook/               # runtime state (staged/, logs/, state DB, settings)
```

```bash
node bin/skyhook.js init --provider sqlite
# provider: stage | sqlite | supabase | postgres
```

It refuses to overwrite an existing `skyhook.config.json`.

## Opening the desktop window

`skyhook app` starts the server and opens the GUI in a window with no browser chrome — Edge's or
Chrome's `--app=` mode, whichever is installed. Nothing is installed for this: the window is the
GUI `skyhook serve` already serves, in a window that is only that page.

```bash
node bin/skyhook.js app              # free loopback port, e.g. http://127.0.0.1:51923
node bin/skyhook.js app --port 4173  # a port you know, if something else expects it
```

The port defaults to a free one so two projects on one machine never fight over 4173. Ctrl+C stops
the server and releases the session lock in `.skyhook/`; only one app session runs per data
directory, and a second one is refused naming the pid that holds it. A machine with neither browser
falls back to the default one — same server, with tabs and an address bar.

`skyhook serve` is unchanged, and remains the way to reach the GUI from a Pi or a peer: the browser
surface is still supported, not a fallback.

## Scheduling on a timer (systemd)

Each seeder has a cadence — `hourly`, `6h`, `12h`, `daily`, `weekly`, `monthly`, or
`manual`. The systemd timer is regenerated from the **fastest enabled cadence**:

```bash
node bin/skyhook.js emit-timer            # write .skyhook/skyhook-seed.timer
node bin/skyhook.js emit-timer --dry-run  # preview the OnCalendar value
```

`systemd/skyhook-seed.timer` is a template; `emit-timer` writes the live unit to
`.skyhook/`. Install it on the machine that runs the seeders:

```bash
sudo cp .skyhook/skyhook-seed.timer /etc/systemd/system/
sudo cp systemd/skyhook-seed.service /etc/systemd/system/
# edit WorkingDirectory / ExecStart paths in the .service first
sudo systemctl daemon-reload
sudo systemctl enable --now skyhook-seed.timer
```

The bundled `.service` runs `bin/skyhook.js run-due` once per timer tick with
`SKYHOOK_STAGE_ONLY=1 SKYHOOK_SKIP_HEADLESS=1` (stage-only, no headless browser).
Tune those for your setup.

## Desktop shell (development)

The optional Tauri shell hosts the same server in a WebView2 window: it starts
`desktop/server.js` as a child process, reads the URL that child prints, and kills
it on exit. The renderer is `src/gui/` unchanged, and `better-sqlite3` keeps
loading under plain Node, so nothing native links into the window.

```powershell
rustup default stable          # Rust toolchain
# plus the MSVC Build Tools ("Desktop development with C++") and WebView2
cargo install tauri-cli        # provides `cargo tauri`, which the npm scripts call
npm run desktop                # cargo tauri dev: window on the sidecar's URL
npm run build:desktop-icons    # regenerate src-tauri/icons/ from src/gui/icons/
npm run desktop:dist           # build the NSIS installer into dist/desktop/
```

None of this is needed for `npm ci`, `npm test`, or any `skyhook` command — the
shell is an optional layer.

`npm run desktop:dist` is four steps in one. `scripts/fetch-sidecar.mjs` downloads the
runtime `desktop/sidecar.json` pins, refuses it unless the pin's `sha256` **and**
nodejs.org's own `SHASUMS256.txt` agree, and unpacks it to
`src-tauri/binaries/skyhook-sidecar-x86_64-pc-windows-msvc.exe` — the name Tauri's
`externalBin` requires. `scripts/stage-desktop-app.mjs` assembles the application that
runtime runs: `desktop/`, `src/` and `config/` plus a production `node_modules`, installed
**by the pinned runtime** so `better-sqlite3`'s build matches the Node the installer
ships, and then loaded once to prove it. `cargo tauri build` bundles the result as the
`app` resource, and the installer is copied to `dist/desktop/`.

A build also produces the **updater** half: the `.nsis.zip` an installed copy downloads, its
minisign `.sig`, and a generated `latest.json` naming both. Signing happens inside `tauri build`, so
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be in the environment —
the wrapper refuses before it compiles when they are missing, because an unsigned artifact is one no
installed copy will accept. The public half of that keypair is `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json` (committed, harmless); the private half never is, and losing it means
installed copies can no longer update. `cargo tauri signer generate -w <path>` makes a new pair.

An installed copy carries the whole server, not a script: `desktop/server.js` imports
`src/interfaces/app-session.js`, which imports everything else. It runs the `node.exe`
beside its own executable and never the `node` on `PATH` — a release build refuses to
start without it. The `desktop` job in `.github/workflows/ci.yml` runs the same command
on a tag only, never on a pull request.

The installer is **unsigned**: Authenticode is the one part of a desktop release that
cannot be code, and it waits on a certificate, so Windows will call it an unrecognised
app until one is bought and wired into `bundle.windows.signCommand`. The route is chosen
in the plan tree; what a reader of this file needs is the consequence — *More info* →
*Run anyway*, and the app runs only the runtime it shipped, never the `node` on `PATH`,
which is what `desktop/sidecar.json` and `test/desktop-guard.test.mjs` exist to keep true.

What an installed build ships is pinned in `desktop/sidecar.json`: the `node.exe`
24.x release that becomes the sidecar, its artifact and its checksum.
`test/desktop-guard.test.mjs` fails when that major stops matching the one
`.github/workflows/ci.yml` tests on, and it guards the two other ways a desktop
build could drift — a `src/core`, `src/engine` or `src/adapters` import in
`desktop/`, and a capability that grants the window more than `core` + `opener` +
`autostart`.

The window is not a browser tab, and the shared renderer is told so by the flag the
shell injects (`window.__SKYHOOK_DESKTOP__`) rather than by a user-agent guess: the
API-base prompt is removed, so a base URL a browser session left in `localStorage`
cannot redirect the window away from the server the shell spawned, the PWA manifest
link is not offered to a webview that cannot install it, and an `http(s)` link opens
in the system browser instead of navigating the window off the dashboard.

The app is also the scheduler on Windows. While it runs, the sidecar's child asks
its own server what is due once a minute and starts it: no systemd timer, no
registered OS task, and no second copy of the cadence rules — `/api/due` is the
same selector the *Run due now* menu item uses. A seeder whose run is still in
flight is skipped, because `last_run_at` is written when a run *ends* and the due
selector would otherwise offer it again. *Start with Windows* — in the app menu and
the tray — writes a per-user `Run` entry, not a service, and the check mark is read
back from that entry, so the toggle survives a restart without anything being
stored twice. `emit-timer` stays the Linux path, untouched.

State lives in the app data directory the shell passes to the sidecar
(`--root`), which is `%APPDATA%\com.sevenlynx.skyhook` on Windows — not the
directory the shell was launched from.

## Releasing to a consumer

A consumer pins a **tag**, never a branch:

```json
"skyhook": "github:seven-lynx/skyhook#v0.4.2"
```

So the release is four steps in this order — a tag on a commit nobody can fetch is not a release:

```bash
git checkout main
git merge --ff-only <branch that tips the release line>   # never a plain merge on the release path
git push origin main
git tag -a v0.4.2 -m "v0.4.2 — what the release changes"
git push origin v0.4.2
```

Release history is `CHANGELOG.md`, newest first: the release's own section is written in
the same commit as the version bump, and the README **Status** paragraph is rewritten
from it rather than the other way round.

A release that ships the desktop app carries four assets, and the tag produces them: `on.push` in
`.github/workflows/ci.yml` names `tags: ["v*"]`, so pushing the tag starts the tag-only `desktop`
job, which builds on `windows-latest` with the signing key from CI secrets and attaches
`Skyhook_<version>_x64-setup.exe`, its `.nsis.zip`, that zip's `.sig`, and `latest.json` to the
Release. Without that `tags` filter a tag push runs no workflow at all, so the job's `refs/tags/v`
guard had nothing to guard and a release attached nothing (#35). An installed copy polls
`releases/latest/download/latest.json`, so a Release without those four strands everyone who
installed the previous version — build and sign first, upload second, announce last.

The version lives in three places, and all must agree before the tag: `package.json`,
the README **Status** line, and — once the desktop track ships — the bundle `version` in
`src-tauri/tauri.conf.json`. Nothing compares the third one, so it is set by hand or the
app's updater compares the wrong number. The `CHANGELOG.md` entry for the version is
written in the same commit.

Then prove the tag from outside the working copy, because the consumer installs the published
tree and not this checkout:

```bash
npm i github:seven-lynx/skyhook#v0.4.2   # in a scratch directory
npm ls skyhook --depth=0                 # prints the resolved version
```

A change to the upload or tagging path is documented in [pipeline.md](pipeline.md) and
[tagging.md](tagging.md) before it is tagged. The README Status paragraph describes the release
as a whole, so it is written at tag time rather than per commit.

## Multi-node

The Pi runs the same timer in worker mode; the PC pulls its staged results. See
[multi-node.md](multi-node.md) for the controller/worker setup.

`skyhook serve` exposes the API on this machine only: it binds `127.0.0.1` unless
`--host` names another address, and a non-loopback bind with no `remote.token` is
refused at startup ([api.md](api.md#auth)).
