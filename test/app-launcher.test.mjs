/**
 * app-launcher.test.mjs — what `skyhook app` will launch, and with what argv.
 *
 * The launcher's failures are silent ones: the wrong binary opened, or a URL that
 * reached a shell as a command. Both are decided before `spawn`, so platform,
 * environment, filesystem and `spawn` are injected and nothing here starts a
 * process or opens a window.
 *
 * The win32 expectations use backslashes and the Linux ones a `PATH`, so the
 * assertions hold on CI's Ubuntu runner as well as a Windows workstation — the
 * launcher joins with `path.win32` / `path.posix` per platform, never the host's
 * separator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAppBrowser, defaultBrowserOpener, openAppWindow } from "../src/interfaces/app-launcher.js";

const APP_URL = "http://127.0.0.1:4321/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WIN_ENV = {
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
};

/** An `existsSync` stand-in that calls only the listed paths installed. */
const installed = (...paths) => (candidate) => paths.includes(candidate);

/** A `spawn` stand-in that records the call and returns the two methods used. */
function recorder(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
}

test("app launcher: Edge wins on Windows, Chrome is the fallback, neither is null", () => {
  const win = { platform: "win32", env: WIN_ENV };
  assert.equal(findAppBrowser({ ...win, exists: installed(EDGE, CHROME) }), EDGE);
  assert.equal(findAppBrowser({ ...win, exists: installed(CHROME) }), CHROME);
  assert.equal(findAppBrowser({ ...win, exists: installed() }), null);
});

test("app launcher: a Linux browser is found on PATH, not at a fixed path", () => {
  const linux = { platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" } };
  assert.equal(
    findAppBrowser({ ...linux, exists: installed("/usr/bin/google-chrome") }),
    "/usr/bin/google-chrome",
  );
  assert.equal(findAppBrowser({ ...linux, exists: installed() }), null);
});

test("app launcher: app mode passes one --app= argument and no other browser flag", () => {
  const calls = [];
  const result = openAppWindow(APP_URL, {
    platform: "win32", env: WIN_ENV, exists: installed(EDGE), spawn: recorder(calls),
  });
  assert.equal(result.mode, "app");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, EDGE);
  assert.deepEqual(calls[0].args, [`--app=${APP_URL}`]);
  assert.equal(calls[0].options.stdio, "ignore", "a browser cannot write over the CLI's output");
  assert.equal(calls[0].options.windowsHide, true);
});

test("app launcher: no app-mode browser falls back to the platform's URL opener", () => {
  assert.deepEqual(
    defaultBrowserOpener({ platform: "win32", env: { ComSpec: "C:\\Windows\\cmd.exe" }, url: APP_URL }),
    { command: "C:\\Windows\\cmd.exe", args: ["/c", "start", "", APP_URL] },
  );
  assert.deepEqual(
    defaultBrowserOpener({ platform: "darwin", url: APP_URL }),
    { command: "open", args: [APP_URL] },
  );
  assert.deepEqual(
    defaultBrowserOpener({ platform: "linux", url: APP_URL }),
    { command: "xdg-open", args: [APP_URL] },
  );

  const calls = [];
  const result = openAppWindow(APP_URL, {
    platform: "linux", env: { PATH: "/usr/bin" }, exists: installed(), spawn: recorder(calls),
  });
  assert.equal(result.mode, "default");
  assert.equal(calls[0].command, "xdg-open");
  assert.deepEqual(calls[0].args, [APP_URL]);
});

test("app launcher: a non-http URL is refused before anything spawns", () => {
  const calls = [];
  assert.throws(
    () => openAppWindow("file:///C:/Windows/System32/calc.exe", {
      platform: "win32", env: WIN_ENV, exists: installed(EDGE), spawn: recorder(calls),
    }),
    /not an http\(s\) URL/,
  );
  assert.equal(calls.length, 0);
});
