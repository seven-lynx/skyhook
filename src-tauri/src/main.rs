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

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
}

impl Session {
    fn base_url(&self) -> Option<String> {
        self.base_url.lock().ok().and_then(|url| url.clone())
    }

    fn root(&self) -> Option<PathBuf> {
        self.root.lock().ok().and_then(|root| root.clone())
    }
}

/// The script to run, from the bundle when D8 ships one and from the checkout
/// that built this binary until then.
fn sidecar_script(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("desktop").join("server.js");
        if packaged.exists() {
            return packaged;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../desktop/server.js"))
}

/// Start the sidecar and wait for its handshake line.
///
/// D3 runs the dev machine's `node`; D8 swaps in the pinned `node.exe` shipped
/// beside the installed exe as an `externalBin`. `--root` is passed because the
/// sidecar resolves every config path against its working directory
/// (`src/config.js:134,149-151`) — without it an installed build would write
/// `.skyhook/` next to its own exe instead of under `%APPDATA%`.
async fn spawn_sidecar(app: &AppHandle) -> Result<(CommandChild, SidecarInfo), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("no app data directory: {err}"))?;
    fs::create_dir_all(&root).map_err(|err| format!("cannot create {}: {err}", root.display()))?;

    let script = sidecar_script(app);
    let (mut events, child) = app
        .shell()
        .command("node")
        .args([
            script.to_string_lossy().into_owned(),
            "--root".to_string(),
            root.to_string_lossy().into_owned(),
            "--watch-stdin".to_string(),
        ])
        .spawn()
        .map_err(|err| format!("cannot start {}: {err}", script.display()))?;

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
fn open_dashboard(app: &AppHandle, base_url: &str) -> Result<(), String> {
    let url = Url::parse(base_url).map_err(|err| format!("bad sidecar URL {base_url}: {err}"))?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Skyhook")
        .inner_size(1440.0, 900.0)
        .min_inner_size(720.0, 520.0)
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
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let data = MenuItem::with_id(app, "open-data", "Open data folder", true, None::<&str>)?;
    let log = MenuItem::with_id(app, "open-log", "Open latest log", true, None::<&str>)?;
    let run = MenuItem::with_id(app, "run-due", "Run due now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(
        app,
        &[&data, &log, &run, &PredefinedMenuItem::separator(app)?, &quit],
    )
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
            Some(base) => match run_due(&base, None) {
                Ok(0) => eprintln!("run due: nothing is due"),
                Ok(count) => eprintln!("run due: started {count} seeder(s)"),
                Err(err) => eprintln!("run due: {err}"),
            },
            None => eprintln!("run due: no session yet"),
        },
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
    let menu = build_menu(app)?;
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
        .menu(|app| build_menu(app))
        .manage(Session::default())
        .setup(|app| {
            let handle = app.handle().clone();
            install_tray(&handle)?;
            tauri::async_runtime::spawn(async move {
                match spawn_sidecar(&handle).await {
                    Ok((child, info)) => {
                        eprintln!("sidecar: {} (port {})", info.base_url, info.port);
                        {
                            let session = handle.state::<Session>();
                            if let Ok(mut slot) = session.child.lock() {
                                *slot = Some(child);
                            }
                            if let Ok(mut url) = session.base_url.lock() {
                                *url = Some(info.base_url.clone());
                            }
                            if let Ok(mut root) = session.root.lock() {
                                *root = Some(PathBuf::from(&info.root));
                            }
                        }
                        if let Err(err) = open_dashboard(&handle, &info.base_url) {
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




