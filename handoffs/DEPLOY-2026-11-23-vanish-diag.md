# Deploy record — vanish diagnostics, 2026-11-23

Deployed the chat-vanish diagnostics instrumentation to the live Hephaestus stack.
Executed by the relay leg-2 session continuing handoff
`handoffs/RELAY-vanish-diagnostics-2026-11-23-leg2.md` (the leg carried the deploy
plan rbowen's slowness-investigation chain authorized; no new scope was added).

## What shipped

Fork `/home/rbowen/pi/pi-web-fork`, branch `fix/chat-scroll-fling-guard-tail`, HEAD
`1797d0465c859d7ac75d96c10227ee4d5a3e82ed`:

- `3e1520b5` feat(client+server): vanish diagnostics — session-list transitions
  logged server-side. The browser batches diagnostic events and POSTs them to the
  new `POST /api/client-diagnostics` endpoint (transport bounds enforced: max 50
  events/request, max 2000 chars/event, strict `kind` pattern); each event becomes
  one `vanish-diag`-tagged info line in the pi-web journal. Client reporter:
  `src/client/src/vanishDiagnostics.ts` (100-event cap, 2s debounce, keepalive
  POST, refill on failure, never throws, pagehide flush). Emissions cover
  `vanish-candidate` (a refresh came back without the selected session; carries
  reason, selInFetched, selection facts, next id), `created-upsert` /
  `created-suppressed`, `lifeline-consumed` / `lifeline-readded`, plus boot and
  browser-resume markers with refresh reasons.
- `1797d046` docs: relay handoff for the vanish-diagnostics chain.
- (this leg) comment-only correction in the three new files: the sink is journald,
  not Loki — see "Log sink correction" below.

This is instrumentation only. It does NOT change any vanish behavior; the
follow-up fix awaits rbowen's explicit authorization once a vanish is caught.

## Deploy artifacts

- Gateway release: `/home/rbowen/.local/share/pipeline-releases/gateway/1797d0465c859d7ac75d96c10227ee4d5a3e82ed/`
  (full build from a clean HEAD tree; `node_modules` → dependency store
  `ed4eb03e…` — the fork's `package-lock.json` sha256 equals the store name, so no
  install was needed; `release.json` carries `qualificationRun: null` — manual
  deploy, not pipeline-qualified)
- Systemd drop-in: `~/.config/systemd/user/pi-web.service.d/80-utc-qualified-4a87ee859a77-1797d046.conf`
  (sorts after `79-…`, so it wins; Environment block byte-identical to `79-`
  (diff-verified), only ExecStart differs → new release)
- Installed package: `~/.local/lib/node_modules/@jmfederico/pi-web/dist` moved to
  `dist.pre-vanish-diag-2026-11-23-1851`, new dist copied in from the release
- New client bundle: `index-CrpG9JJn.js` (previous served: `index-2ILgiWem.js`)

## Restart

Detached: `systemd-run --user --unit=piweb-vanish-diag-restart-20261123 /bin/bash
/tmp/piweb-vanish-diag-2026-11-23/restart.sh` — log at
`/tmp/piweb-vanish-diag-2026-11-23/restart.log`.

1. `pi-web.service` (8504 gateway) — answering 4 s after restart
2. `pi-web-ui.service` (8505 comparison instance) — answering 10 s after restart

`pi-web-sessiond.service` was NOT restarted: the deploy touches no sessiond code
and sessiond hosts the live sessions.

## Verification (all pass, 2026-11-23 ~18:53 UTC)

- [x] `POST /api/client-diagnostics` with `{"events":[{"kind":"boot"}]}` → HTTP 204
- [x] journal line appeared: `{"level":30,…,"tag":"vanish-diag","kind":"boot"}` in
      `journalctl --user -u pi-web`
- [x] gateway serves the new bundle `assets/index-CrpG9JJn.js` (asset fetch 200)
- [x] journals clean: zero error-level lines in `pi-web.service` and
      `pi-web-ui.service` since restart (baseline before deploy was also zero)
- [x] gateway MainPID runs
      `gateway/1797d0465c859d7ac75d96c10227ee4d5a3e82ed/dist/server/index.js`

## Log sink correction (differs from the earlier handoff)

The leg-2 handoff and the code comments assumed Alloy ships pi-web's journald
output to Loki. Verified against the live system: the Alloy shippers
(`/opt/vps-1-infra-repo/{prod,ci}/logging/alloy-*.alloy`) scrape docker containers
only — no journald source; Loki's `unit` label has exactly one value
(`pipeline.service`, `source=pipeline-journal`). pi-web logs live in journald only.
Hunt a vanished chat with:

```
journalctl --user -u pi-web | grep vanish-diag
```

`vanish-candidate` events carry `reason` (browser-resume / socket-reconnect /
cleanup) and `selInFetched` (was the selected session id in the fetched list?) —
that pair separates server-side omission from a client-side filter. The three
code comments were corrected in this leg to say journald.

Two claims in the previous deploy record also do not hold on the live system and
are corrected here for the next reader: `https://localhost:8504` never speaks TLS
(the gateway answers plain HTTP; "packet length too long" from openssl s_client;
TLS terminates at the router front door), and `pi-web-ui.service` (8505) serves
its own install (`~/.local/lib/node_modules/pi-web-ui/web/dist`, bundle
`index-3XU67qMh.js`) — it does not pick up the swapped `@jmfederico/pi-web` dist.

## Rollback (instant)

- `rm ~/.config/systemd/user/pi-web.service.d/80-utc-qualified-4a87ee859a77-1797d046.conf`
  → `systemctl --user daemon-reload` → `systemctl --user restart pi-web.service`
  (falls back to gateway `97206a35…` via the `79-` drop-in)
- `mv ~/.local/lib/node_modules/@jmfederico/pi-web/dist{.pre-vanish-diag-2026-11-23-1851,}`
  → `systemctl --user restart pi-web.service` (and `pi-web-ui.service` if 8505 is
  in use)
