// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Skyhook desktop shell — a view and a supervisor, nothing more.
//!
//! `desktop/server.js` is a real Node child process, so `better-sqlite3` keeps a
//! Node ABI and this crate never links it. What the shell owes that child is a
//! short list: start it with a data root, read the one JSON line it announces,
//! point the window at that URL, and kill it when the app goes away.
//!
//! Two conventions come from the sidecar's own contract and are not obvious here:
//!
//! * The handshake is the first stdout line that parses as JSON, not the first
//!   line — `startServer()` prints a human banner before it (`api-server.js:537-539`).
//! * Nothing is stored twice. The URL, the root and the child handle live in one
//!   `Session`, because a window reload must reuse the running server and Quit
//!   must leave no `node` behind at the `.app-session.lock`.
//!
//! The shell is also the scheduler on Windows: the sidecar's child ticks the due
//! set while the app runs (`desktop/schedule.js`), so there is no systemd unit and
//! no registered OS task. The only thing Windows is told is where the exe lives —
//! the *Start with Windows* check item, a per-user `Run` entry the autostart plugin
//! writes and reads back, so the menu holds no second copy of that fact.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// The OS CSPRNG, declared by hand.
//
// `windows` is in the lock file only as a tauri dependency, and reaching into it
// for one function would pin an API surface that is not ours. `bcrypt.lib` ships
// with the Windows SDK the MSVC build already needs, and a null algorithm handle
// plus this flag is the documented "use the system-preferred generator" form.
// (A doc comment is not used here: rustdoc does not document `extern` blocks, and
// `cargo build` warns about it.)
#[cfg(windows)]
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        length: u32,
        flags: u32,
    ) -> i32;
}

/// The token this launch shares with the sidecar and the window (DC7).
///
/// 32 bytes from the OS, hex-encoded once: the sidecar gets it as
/// `SKYHOOK_REMOTE_TOKEN` and the window as `window.__SKYHOOK_DESKTOP__`. It is
/// never written to disk — a per-launch secret has nothing to store.
fn launch_token() -> String {
    let mut bytes = [0u8; 32];

    #[cfg(windows)]
    {
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        // SAFETY: `bytes` is 32 writable bytes, the length matches, and a null
        // algorithm handle is what the flag above is defined to accept.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        // No token is not a degraded mode — the window would be locked out of its
        // own server — so this fails loudly rather than quietly.
        assert_eq!(status, 0, "BCryptGenRandom failed with status {status:#x}");
    }

    #[cfg(not(windows))]
    {
        std::fs::File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .expect("no OS entropy source at /dev/urandom");
    }

    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The handshake `desktop/server.js` prints on its own line.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarInfo {
    base_url: String,
    port: u16,
    root: String,
}

/// Everything the shell knows about the session it supervises.
#[derive(Default)]
struct Session {
    child: Mutex<Option<CommandChild>>,
    base_url: Mutex<Option<String>>,
    root: Mutex<Option<PathBuf>>,
    token: Mutex<Option<String>>,
}

impl Session {
    fn base_url(&self) -> Option<String> {
        self.base_url.lock().ok().and_then(|url| url.clone())
    }

    fn root(&self) -> Option<PathBuf> {
        self.root.lock().ok().and_then(|root| root.clone())
    }

    fn token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|token| token.clone())
    }
}

/// Replace one of the session's slots, ignoring a poisoned lock.
///
/// Every slot is only ever replaced wholesale — the token at launch, the child and the
/// URL when the handshake lands — so a panic elsewhere in the shell must not turn a
/// poisoned mutex into a second, unrelated failure. This is also why the writes are a
/// `match` on the lock rather than an `if let`: the guard's temporary has to be dropped
/// inside the statement, or the borrow outlives the `State` it came from.
fn remember<T>(slot: &Mutex<Option<T>>, value: T) {
    match slot.lock() {
        Ok(mut guard) => *guard = Some(value),
        Err(poisoned) => *poisoned.into_inner() = Some(value),
    }
}

/// A path the child can actually open.
///
/// `resource_dir()` and `app_data_dir()` are derived from `current_exe()`, which on
/// Windows is a verbatim path (`\\?\C:\…`). The OS accepts it; Node 20 does not — a
/// verbatim entry script fails in `resolveMainPath` with `EISDIR: lstat 'C:'`, which is
/// how the first installed build refused to start. The prefix is stripped rather than
/// canonicalized away, because `canonicalize` is what adds it.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// The script to run, from the bundle when it shipped one and from the checkout
/// that built this binary until then.
///
/// The installed tree is the repository's own layout under `app/` — the sidecar imports
/// `src/interfaces/app-session.js`, which imports the server, so the installer carries the
/// application rather than a script (`scripts/stage-desktop-app.mjs`).
fn sidecar_script(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("app").join("desktop").join("server.js");
        if packaged.exists() {
            return plain_path(&packaged);
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../desktop/server.js"))
}

/// The runtime an installed build ships: the pinned `node.exe`, renamed to
/// `skyhook-sidecar.exe` by Tauri's `externalBin` and installed beside the app's own
/// executable. Absent in a checkout, which is the only place `node` from `PATH` is
/// used at all (DC6, DC11).
fn bundled_runtime() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let exe = dir.join(format!("skyhook-sidecar{}", std::env::consts::EXE_SUFFIX));
    exe.exists().then_some(exe)
}

/// Start the sidecar and wait for its handshake line.
///
/// A development build runs the machine's `node` on the checkout's script; an installed
/// build runs the pinned `node.exe` the bundle shipped beside its exe as an `externalBin`
/// (`desktop/sidecar.json`, `scripts/fetch-sidecar.mjs`). `--root` is passed because the
/// sidecar resolves every config path against its working directory
/// (`src/config.js:134,149-151`) — without it an installed build would write
/// `.skyhook/` next to its own exe instead of under `%APPDATA%`. `SKYHOOK_REMOTE_TOKEN`
/// is set here, so the one credential the window holds is also the one this server
/// accepts (`src/core/remote.js`, `acceptedTokens`).
async fn spawn_sidecar(app: &AppHandle, token: &str) -> Result<(CommandChild, SidecarInfo), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("no app data directory: {err}"))?;
    let root = plain_path(&root);
    fs::create_dir_all(&root).map_err(|err| format!("cannot create {}: {err}", root.display()))?;

    let script = sidecar_script(app);
    let runtime = bundled_runtime();

    // An installed copy may only run the runtime it shipped (DC6): no sidecar beside the
    // exe in a release build is a broken install, not an invitation to use the user's Node.
    if runtime.is_none() && !cfg!(debug_assertions) {
        return Err("the bundled runtime is missing beside the app (desktop/sidecar.json)".into());
    }

    let builder = match &runtime {
        Some(exe) => app.shell().command(exe.to_string_lossy().into_owned()),
        None => app.shell().command("node"),
    };
    // Which runtime and which script, in the app's own log: an installed build's only
    // audit trail for the ABI it runs (DC6), and the first line to read when a sidecar
    // refuses to start.
    eprintln!(
        "sidecar: launching {} {}",
        runtime
            .as_ref()
            .map(|exe| exe.display().to_string())
            .unwrap_or_else(|| "node (PATH)".to_string()),
        script.display()
    );
    let (mut events, child) = builder
        .args([
            script.to_string_lossy().into_owned(),
            "--root".to_string(),
            root.to_string_lossy().into_owned(),
            "--watch-stdin".to_string(),
        ])
        .env("SKYHOOK_REMOTE_TOKEN", token)
        .spawn()
        .map_err(|err| format!("cannot start the sidecar ({}): {err}", script.display()))?;

    // Chunks are not lines: the banner and the handshake can arrive split across
    // reads, and a handshake cut in half must still be parsed whole.
    let mut pending = String::new();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(newline) = pending.find('\n') {
                    let line = pending[..newline].trim().to_string();
                    pending.drain(..=newline);
                    if !line.starts_with('{') {
                        continue; // the server's human banner (api-server.js:537-539)
                    }
                    if let Ok(info) = serde_json::from_str::<SidecarInfo>(&line) {
                        return Ok((child, info));
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                eprintln!("sidecar: {}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Terminated(payload) => {
                return Err(format!(
                    "the sidecar stopped before it announced a URL (exit code {:?})",
                    payload.code
                ));
            }
            _ => {}
        }
    }
    Err("the sidecar closed its output before it announced a URL".into())
}

/// One HTTP request to our own sidecar, over plain TCP.
///
/// The target is always the loopback URL the child just printed, and the other
/// end is this process's own child, so TLS, redirects and keep-alive are all
/// noise — an HTTP client crate would be a dependency for nothing. `token` is
/// where D5's per-launch bearer secret arrives.
fn request(
    base_url: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> Result<String, String> {
    let authority = base_url
        .strip_prefix("http://")
        .ok_or_else(|| format!("not a loopback http URL: {base_url}"))?;
    let mut stream =
        TcpStream::connect(authority).map_err(|err| format!("connect {authority}: {err}"))?;
    let auth = token
        .map(|secret| format!("Authorization: Bearer {secret}\r\n"))
        .unwrap_or_default();
    let message = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n{auth}\r\n{body}",
        body.as_bytes().len()
    );
    stream
        .write_all(message.as_bytes())
        .map_err(|err| format!("write {path}: {err}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|err| format!("read {path}: {err}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("{path}: truncated response"))?;
    if !head.starts_with("HTTP/1.1 2") && !head.starts_with("HTTP/1.0 2") {
        let status = head.lines().next().unwrap_or("HTTP/1.1 ?").trim();
        return Err(format!("{path}: {status}"));
    }
    Ok(response_body.to_string())
}

/// Menu action *Run due now* — the same two calls the GUI makes.
///
/// `/api/due` applies the cadence rules server-side (`api-server.js:178`), so the
/// shell keeps no second copy of `CADENCE_MS`; `/api/run` then starts them.
fn run_due(base_url: &str, token: Option<&str>) -> Result<usize, String> {
    let raw = request(base_url, "GET", "/api/due", token, "")?;
    let due: Value = serde_json::from_str(&raw).map_err(|err| format!("/api/due: {err}"))?;
    let sources: Vec<String> = due
        .as_array()
        .ok_or_else(|| "/api/due: expected a list".to_string())?
        .iter()
        .filter_map(|row| row.get("source").and_then(Value::as_str).map(str::to_string))
        .collect();
    if sources.is_empty() {
        return Ok(0);
    }
    let body = json!({ "sources": sources }).to_string();
    request(base_url, "POST", "/api/run", token, &body)?;
    Ok(sources.len())
}

/// The newest log file under `<root>/.skyhook/logs`, for *Open latest log*.
fn latest_log(root: &Path) -> Option<PathBuf> {
    fs::read_dir(root.join(".skyhook").join("logs"))
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .max_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok())
        .map(|entry| entry.path())
}

/// The dashboard: the sidecar's own origin, so every call is same-origin.
///
/// The injected flag is the renderer half of the handshake (`src/gui/app.js`,
/// `desktopToken`): `api()` adds `Authorization` only when it exists, so a browser
/// session is untouched. It runs before any page script and again on reload, and
/// `serde_json` escapes the token rather than pasting it raw.
fn open_dashboard(app: &AppHandle, base_url: &str, token: &str) -> Result<(), String> {
    let url = Url::parse(base_url).map_err(|err| format!("bad sidecar URL {base_url}: {err}"))?;
    let script = format!(
        "window.__SKYHOOK_DESKTOP__ = {};",
        json!({ "token": token })
    );
    // The window belongs to one origin — the sidecar's — so a link out of it is handed
    // to the system browser and the navigation cancelled. A stray href can then never
    // strand the app on a page with no way back, and a same-origin reload or hash route
    // passes untouched, which is how the renderer already moves between its screens.
    // The comparison is scheme + host + defaulted port rather than a string prefix,
    // so `http://127.0.0.1:41730` cannot pass for the session on `:4173`.
    let home_scheme = url.scheme().to_string();
    let home_host = url.host_str().map(str::to_string);
    let home_port = url.port_or_known_default();
    let opener = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Skyhook")
        .inner_size(1440.0, 900.0)
        .min_inner_size(720.0, 520.0)
        .initialization_script(script.as_str())
        .on_navigation(move |target| {
            let at_home = target.scheme() == home_scheme.as_str()
                && target.host_str() == home_host.as_deref()
                && target.port_or_known_default() == home_port;
            if at_home {
                return true;
            }
            if matches!(target.scheme(), "http" | "https") {
                if let Err(err) = opener.opener().open_url(target.as_str(), None::<String>) {
                    eprintln!("open link: {err}");
                }
            }
            false
        })
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// A page that carries the reason instead of a blank window.
///
/// The usual cause is a missing `node`, and the message names the file it could
/// not start — a stack trace says less to the person in front of the screen.
fn failure_page(reason: &str) -> String {
    let escaped = reason
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Skyhook could not start</title>\
         <body style=\"font:14px/1.6 Consolas,monospace;background:#111;color:#e8e8e8;padding:32px\">\
         <h1 style=\"font-size:15px;color:#ff7a29\">Skyhook could not start</h1>\
         <pre style=\"white-space:pre-wrap\">{escaped}</pre></body>"
    );
    let mut url = String::from("data:text/html;charset=utf-8,");
    for byte in html.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            url.push(byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

fn open_failure(app: &AppHandle, reason: &str) -> Result<(), String> {
    let url = Url::parse(&failure_page(reason)).map_err(|err| err.to_string())?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Skyhook could not start")
        .inner_size(760.0, 420.0)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// The app menu, shared by the window and the tray.
///
/// *Start with Windows* is a check item whose mark is read from the OS's own Run
/// entry, so an install where the entry exists shows it — nothing here remembers
/// the answer. The mark is passed in rather than re-read so a toggle can rebuild the
/// tray's menu with the value it just wrote.
fn build_menu(app: &AppHandle, autostart_checked: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let data = MenuItem::with_id(app, "open-data", "Open data folder", true, None::<&str>)?;
    let log = MenuItem::with_id(app, "open-log", "Open latest log", true, None::<&str>)?;
    let run = MenuItem::with_id(app, "run-due", "Run due now", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start with Windows",
        true,
        autostart_checked,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(
        app,
        &[
            &data,
            &log,
            &run,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Whether this user's launch entry exists — read from the plugin, never stored.
fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Re-state the check mark on both menus that carry it, after a toggle.
///
/// The item exists twice — the window's menu bar and the tray's — because each is a
/// separate menu. `TrayIcon` in tauri 2.12 offers `set_menu` and no getter (checked in
/// the crate source, `tray/mod.rs:526`), so the tray's copy is replaced with a freshly
/// built menu rather than read back; the window's copy is walked. A mark that disagreed
/// with the Run entry would be the only copy of that fact anywhere, which is what
/// reading the OS exists to avoid.
fn sync_autostart_checks(app: &AppHandle, checked: bool) {
    if let Some(tray) = app.tray_by_id("skyhook") {
        match build_menu(app, checked) {
            Ok(menu) => {
                if let Err(err) = tray.set_menu(Some(menu)) {
                    eprintln!("tray menu: {err}");
                }
            }
            Err(err) => eprintln!("tray menu: {err}"),
        }
    }
    if let Some(menu) = app.menu() {
        for item in menu.items().unwrap_or_default() {
            if item.id().as_ref() == "autostart" {
                if let Some(check) = item.as_check_menuitem() {
                    let _ = check.set_checked(checked);
                }
            }
        }
    }
}

/// Menu ids are the contract between this function and `build_menu`.
fn on_menu(app: &AppHandle, id: &str) {
    let session = app.state::<Session>();
    match id {
        "open-data" => match session.root() {
            Some(root) => {
                if let Err(err) = app.opener().open_path(root.to_string_lossy(), None::<String>) {
                    eprintln!("open data folder: {err}");
                }
            }
            None => eprintln!("open data folder: no session yet"),
        },
        "open-log" => match session.root().and_then(|root| latest_log(&root)) {
            Some(log) => {
                if let Err(err) = app.opener().open_path(log.to_string_lossy(), None::<String>) {
                    eprintln!("open latest log: {err}");
                }
            }
            None => eprintln!("open latest log: no log file yet"),
        },
        "run-due" => match session.base_url() {
            Some(base) => match run_due(&base, session.token().as_deref()) {
                Ok(0) => eprintln!("run due: nothing is due"),
                Ok(count) => eprintln!("run due: started {count} seeder(s)"),
                Err(err) => eprintln!("run due: {err}"),
            },
            None => eprintln!("run due: no session yet"),
        },
        // A per-user Run entry, written and read by the plugin: the OS keeps this
        // fact, so a reinstall or a manual edit of the registry shows through.
        "autostart" => {
            let autolaunch = app.autolaunch();
            let wanted = !autolaunch.is_enabled().unwrap_or(false);
            let result = if wanted { autolaunch.enable() } else { autolaunch.disable() };
            match result {
                Ok(()) => sync_autostart_checks(app, wanted),
                // The mark is left as it was: the entry did not move, so neither does it.
                Err(err) => eprintln!("start with windows: {err}"),
            }
        }
        "quit" => {
            kill_sidecar(app);
            app.exit(0);
        }
        _ => {}
    }
}

/// Kill the child explicitly, so the next launch is not refused at the lock.
///
/// `app-session.js` reclaims a lock whose pid is gone, but a child still holding
/// the port would make the next launch fail differently — so this is a kill, not
/// a hope that the process tree dies with the window.
fn kill_sidecar(app: &AppHandle) {
    let session = app.state::<Session>();
    let child = session.child.lock().ok().and_then(|mut slot| slot.take());
    if let Some(child) = child {
        if let Err(err) = child.kill() {
            eprintln!("sidecar kill: {err}");
        }
    }
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, autostart_enabled(app))?;
    let mut tray = TrayIconBuilder::with_id("skyhook")
        .tooltip("Skyhook")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch is a focus request, not a second server: the
            // sidecar's lock would refuse it anyway (`app-session.js:55-73`).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Session::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Menus are built here, not by `Builder::menu`: the autostart item reads
            // the plugin's state, and plugin state exists by the time `setup` runs.
            build_menu(&handle, autostart_enabled(&handle))?.set_as_app_menu()?;
            install_tray(&handle)?;
            let token = launch_token();
            {
                let session = handle.state::<Session>();
                remember(&session.token, token.clone());
            }
            tauri::async_runtime::spawn(async move {
                match spawn_sidecar(&handle, &token).await {
                    Ok((child, info)) => {
                        eprintln!("sidecar: {} (port {})", info.base_url, info.port);
                        {
                            let session = handle.state::<Session>();
                            remember(&session.child, child);
                            remember(&session.base_url, info.base_url.clone());
                            remember(&session.root, PathBuf::from(&info.root));
                        }
                        if let Err(err) = open_dashboard(&handle, &info.base_url, &token) {
                            eprintln!("window: {err}");
                        }
                    }
                    Err(err) => {
                        eprintln!("sidecar: {err}");
                        if let Err(open_err) = open_failure(&handle, &err) {
                            eprintln!("window: {open_err}");
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Skyhook shell")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                kill_sidecar(app);
            }
        });
}




