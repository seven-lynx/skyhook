/**
 * app-launcher.js — the GUI in a window with no browser chrome.
 *
 * `skyhook app` starts a server session in-process (`app-session.js`) and then
 * needs something to render against it. Until a shell owns a window, the cheapest
 * honest answer is the browser's own app mode: Edge and Chrome both take
 * `--app=<url>`, which is a window with no tab strip, no address bar and no menu —
 * and nothing to install. The launcher is therefore the one piece a desktop shell
 * replaces, which is why it takes a URL and returns a process instead of owning a
 * lifecycle.
 *
 * Platform, environment, filesystem and `spawn` are parameters whose defaults are
 * the real thing, so `test/app-launcher.test.mjs` can pin the resolution order and
 * the argument shape without starting a browser. Nothing here imports `src/core`
 * or `src/engine`: a window is a view of the server, never part of it.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { posix, win32 } from "path";

/**
 * Candidate binaries per platform, best first: Edge, then Chrome.
 *
 * Windows spreads installs over three roots depending on bitness and whether the
 * browser shipped with the OS, so every root is tried. Linux entries are command
 * names, not paths — the distro's package manager decided where they live, so
 * `findOnPath` resolves them.
 */
function browserCandidates(platform, env) {
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map((root) => win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((root) => win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
  }
  return ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"];
}

/** Resolve a bare command name against `PATH`; the first hit, or null. */
function findOnPath(name, env, exists) {
  const dirs = (env.PATH || env.Path || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = posix.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The first installed app-mode browser, or `null` when there is none.
 *
 * `null` is not a failure — it means "use the default browser", which
 * `openAppWindow` does with the platform's own opener. Edge is tried before
 * Chrome because it is the binary a stock Windows install already has.
 */
export function findAppBrowser({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates = browserCandidates(platform, env);
  if (platform !== "win32" && platform !== "darwin") {
    for (const name of candidates) {
      const found = findOnPath(name, env, exists);
      if (found) return found;
    }
    return null;
  }
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * The platform's "open this URL" command — a full browser window, with chrome.
 *
 * On Windows that is `cmd /c start`; the empty argument is the window title
 * `start` would otherwise take from the URL. macOS has `open`, and everything
 * else `xdg-open`.
 */
export function defaultBrowserOpener({ platform = process.platform, env = process.env, url } = {}) {
  if (platform === "win32") return { command: env.ComSpec || "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Open `url` in an app-mode window, falling back to the default browser.
 *
 * The URL is always one argv entry and never a shell string, so a URL cannot
 * become a command. `unref()` keeps the child from holding the CLI open — Edge
 * and Chrome usually hand the URL to an already-running instance and exit at
 * once — and a spawn that never launched reports through `error` instead of
 * throwing: the session is still useful, and the URL the caller prints is still
 * a way in.
 */
export function openAppWindow(url, {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  spawn: spawnImpl = spawn,
} = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`not an http(s) URL: ${url}`);
  const browser = findAppBrowser({ platform, env, exists });
  const plan = browser
    ? { mode: "app", command: browser, args: [`--app=${url}`] }
    : { mode: "default", ...defaultBrowserOpener({ platform, env, url }) };

  const child = spawnImpl(plan.command, plan.args, { stdio: "ignore", windowsHide: true });
  child.on("error", (err) => {
    console.warn(`[app] could not open ${plan.command}: ${err.message} — open ${url} in a browser`);
  });
  child.unref();
  return { mode: plan.mode, command: plan.command, args: plan.args, child };
}
