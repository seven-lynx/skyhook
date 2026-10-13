# Deployment & Scheduling

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

## Multi-node

The Pi runs the same timer in worker mode; the PC pulls its staged results. See
[multi-node.md](multi-node.md) for the controller/worker setup.
