/**
 * latest-json.mjs — the update manifest an installed app reads.
 *
 * `tauri-plugin-updater` fetches one static JSON and looks for its own
 * `{{target}}-{{arch}}` key under `platforms`. The signature in it is the minisign
 * signature the build produced beside the `.nsis.zip`, and the URL is where that zip
 * is published — so every field here is copied from an artifact that already exists
 * on disk, never typed by hand. A release that published an installer without this
 * file is a dead end for everyone who installed the previous version.
 *
 * The function is pure (no `fs`, no clock): the wrapper passes the values it already
 * has, and `test/desktop-dist.test.mjs` can refuse a bad manifest without a build.
 */

/**
 * The manifest for one target, or a thrown error naming the field that would make an
 * installed app fail to update. All four inputs come from the build, not from a human.
 */
export function latestManifest({ version, signature, url, notes = "", pubDate, target = "windows-x86_64" }) {
  const missing = [];
  if (!String(version ?? "").trim()) missing.push("version");
  if (!String(signature ?? "").trim()) missing.push("signature");
  if (!String(url ?? "").trim()) missing.push("url");
  if (!pubDate) missing.push("pubDate");
  if (missing.length > 0) throw new Error(`latest.json is missing ${missing.join(", ")}`);

  // A version the updater can compare, and a signature it can verify: `0.4.2` and a
  // base64 blob. A `v` prefix or a truncated signature is the difference between an
  // update and a refusal on the user's machine.
  const versionText = String(version).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(versionText)) {
    throw new Error(`latest.json: "${version}" is not a semver version`);
  }
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new Error(`latest.json: "${url}" is not a URL`);
  }

  return {
    version: versionText,
    notes,
    pub_date: new Date(pubDate).toISOString(),
    platforms: {
      [target]: { signature: String(signature).trim(), url: parsed.toString() },
    },
  };
}
