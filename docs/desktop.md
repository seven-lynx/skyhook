# Desktop app

Status: **guide** — the Windows application: install it, find its data, read the menu, let it
update itself. Building it is [deployment.md](deployment.md#desktop-shell-development).

The desktop app is a Tauri (WebView2) window around the same server every other Skyhook surface
talks to. It ships its own `node.exe`, so the machine you install it on needs no Node, no npm and no
systemd — and `skyhook` on the command line keeps working exactly as before if you have it.

## Install

1. Download `Skyhook_<version>_x64-setup.exe` from the
   [releases page](https://github.com/seven-lynx/skyhook/releases).
2. Run it. Windows says *Windows protected your PC* because the installer is not yet Authenticode
   signed: **More info** → **Run anyway**. The app still only ever runs the runtime it shipped.
3. The installer is per-user by default, so it needs no administrator rights and uninstalls from
   *Settings → Apps*.

The app is Windows 10/11 x64 only. Everywhere else, `skyhook serve` plus a browser — or
`skyhook app` for a browser app-mode window with no extra dependency — is the same dashboard.

## First run

The window opens on the dashboard of a server the app started for you. That server binds a free
port on `127.0.0.1` only, and the window is pinned to that origin: a base URL left in
`localStorage` by a browser session cannot redirect it anywhere else.

The first screen is the same one `skyhook init` produces — seeders, schedules, staged results,
pipeline. Nothing about the app changes what a seeder, a category or a tag means.

## Where the data lives

State lives under the app's own data directory, **not** beside the installer and **not** in the
folder you launched it from:

```
%APPDATA%\com.sevenlynx.skyhook\
  skyhook.config.json        your config, if you put one here
  .skyhook\staged\           staged JSONL, one file per source
  .skyhook\logs\             run logs
  .skyhook\settings.json     runtime toggles written by the GUI
  updates.json               {"checkOnLaunch": true|false}
```

*File → Open data folder* in the menu opens that directory in Explorer, and *Open latest log* opens
the newest run log. Merge or copy a `skyhook.config.json` into that directory and restart the app to
change static config — the same file, and the same defaults, as a command-line install.

## The menu and the tray

The window's menu bar is grouped by what each item is for. The tray icon carries a short list of
its own, because a tray popup opens one level deep.

**File**

| Item | What it does |
|---|---|
| Open data folder | Explorer at `%APPDATA%\com.sevenlynx.skyhook` |
| Open latest log | The newest file under `.skyhook\logs\` |
| Exit | Kills the server child, then exits (`Ctrl+Q`) |

**Run**

| Item | What it does |
|---|---|
| Run due now | Starts every seeder whose cadence is due, through `/api/due` → `/api/run` |

**Settings**

| Item | What it does |
|---|---|
| Start with Windows | A per-user `Run` entry — not a service. The mark is read back from Windows |
| Check for updates automatically | Whether the launch check runs. Off means the app makes no update request at all |
| Check for updates now | Asks once, whatever the toggle says |
| Open Settings… | Sends the window to its own Settings page (`Ctrl+,`) — the same page the rail opens |

**Help**

| Item | What it does |
|---|---|
| Documentation | Opens `docs/README.md` in the repository |
| Report an issue | Opens the repository's issue list |
| About Skyhook | The shell's name, version and licence, in the native dialog |

The tray icon carries *Show Skyhook*, *Run due now*, *Open latest log*, *Start with Windows* and
*Exit*. It is deliberately not the app menu: the update toggles belong to a window you have open.

While the app runs it is also the scheduler: the sidecar asks its own server what is due once a
minute and starts it. There is no Windows scheduled task and no systemd unit. Closing the window
leaves no `skyhook-sidecar` behind and no port bound; the next launch takes the session lock again.

## Updates

The app checks
`https://github.com/seven-lynx/skyhook/releases/latest/download/latest.json` once per launch —
after the window is up, so a download never delays the dashboard.

- **Signature.** The download is verified against the minisign public key compiled into the app,
  and the signature must carry the version it was signed for. A tampered or wrongly-numbered
  artifact is refused before the installer sees it.
- **Install.** The mode is `passive`: Windows runs the installer unattended and restarts the app. It
  quits the app to do that, and the app kills its server child first, so no `.app-session.lock` is
  left held by an orphan.
- **The toggle.** *Check for updates automatically* writes `updates.json` next to the data. Turn it
  off on an air-gapped box: no request is made, and *Check for updates now* stays available when you
  do want one.
- **No update found** is not an error and is reported nowhere the window can see it — the check is
  silent on launch. A failure is written to the app's stderr, which is only visible if you started
  it from a console.

Uninstalling does not delete `%APPDATA%\com.sevenlynx.skyhook`: staged results, logs and your
config survive a reinstall. Delete that directory to start over.
