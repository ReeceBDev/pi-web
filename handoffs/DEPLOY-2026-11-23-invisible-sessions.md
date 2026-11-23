# Deploy record — invisible-sessions fix, 2026-11-23

Deployed the session-visibility fix to the live Hephaestus stack. rbowen authorized
finish + commit + deploy (including the session-daemon restart) in the
agentic-observation-tooling session `01a208d5` on 2026-11-23 ~15:15 UTC.

## What shipped

Fork `/home/rbowen/pi/pi-web-fork`, branch `fix/chat-scroll-fling-guard-tail`, HEAD
`97206a3582956e460f082183a82b11e4638d7ee4`:

- `880f89cc` feat(server): session summary scanner folds only appended bytes on file growth
- `21624ea1` feat(server): projects catalog returns metadata only, no session enumeration
- `33537f75` feat(client): session.created events upsert every loaded workspace list
  (the fix: a session created in any workspace now lands in the sidebar without a reload)
- `97206a35` chore(test): drop unnecessary type assertion in webPushRoutes test

Implementation was done by relay sessions `01a208c7` → `01a208e7` (rbowen's
slowness-investigation chain); this deploy was staged and executed by `01a208d5`.

## Deploy artifacts

- Gateway release: `/home/rbowen/.local/share/pipeline-releases/gateway/97206a3582956e460f082183a82b11e4638d7ee4/`
  (full build; node_modules → dependencies `ed4eb03e…`, unchanged lock; `release.json`
  carries `qualificationRun: null` — manual deploy, not pipeline-qualified)
- Systemd drop-in: `~/.config/systemd/user/pi-web.service.d/79-utc-qualified-4a87ee859a77-97206a35.conf`
  (alphabetically after `78-…`, so it wins; same env as 78, ExecStart → new release)
- Installed package: `~/.local/lib/node_modules/@jmfederico/pi-web/dist` swapped to the
  new build; previous dist kept at `dist.pre-invisible-sessions-2026-11-23-1519`
- New client bundle: `index-2ILgiWem.js` (previous served: `index-Dcq4Ds6P.js`)

## Restart order (per platform law: web/API before session daemon)

1. `pi-web.service` (8504, gateway 97206a35)
2. `pi-web-sessiond.service` (unix socket, new scanner + sessiond code)
3. `pi-web-ui.service` (8505 comparison instance, picks up the swapped dist)

Executed detached: `systemd-run --user --unit=piweb-deploy-restart-20261123
/bin/bash /tmp/piweb-deploy-2026-11-23/restart.sh` — log at
`/tmp/piweb-deploy-2026-11-23/restart.log`.

## Rollback (instant)

- `rm ~/.config/systemd/user/pi-web.service.d/79-utc-qualified-4a87ee859a77-97206a35.conf`
  → `systemctl --user daemon-reload` → `systemctl --user restart pi-web.service`
  (falls back to gateway `dfe6c358…`)
- `mv ~/.local/lib/node_modules/@jmfederico/pi-web/dist{.pre-invisible-sessions-2026-11-23-1519,}`
  → `systemctl --user restart pi-web-sessiond.service`

## Verification (all pass, 2026-11-23 ~15:25 UTC)

- [x] `GET /projects/catalog` on 8504: 10 projects, 283 workspaces, ZERO carry a `sessions` key
- [x] served client bundle is `index-2ILgiWem.js`
- [x] sessiond `/sessions?cwd=…` lists per workspace (18 in agentic-observation-tooling)
- [x] journals clean: zero error-level lines in both units since restart
- [x] gateway MainPID runs `gateway/97206a3582956e460f082183a82b11e4638d7ee4/dist/server/index.js`

Note: the restart script logged "sessiond answering: NO" — the probe URL (`GET
/projects` on the sessiond socket) returns a non-2xx by design; the daemon was
verified healthy with `GET /sessions?cwd=…` right after.
