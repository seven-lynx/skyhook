# Deployment & Scheduling

Status: **guide** — scaffolding with `init`, the systemd timer `emit-timer` regenerates, and the
pointer to the multi-node setup.

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

The version lives in two places, and both must agree before the tag: `package.json` and the
README **Status** line.

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
