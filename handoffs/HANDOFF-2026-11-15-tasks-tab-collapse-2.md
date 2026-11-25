# Handoff — Hephaestus tasks-tab collapse on session switch (continuation)

## 1. Original prompt (verbatim)

"In hepheastus, switching between sessions causes the sessions tasks tab to collapse.
Investigate, rectify, deploy, push"

## 2. Total request (verbatim)

"In hepheastus, switching between sessions causes the sessions tasks tab to collapse.
Investigate, rectify, deploy, push"

## 3. Work done so far (this continuation + prior agent)

- Root cause found and fixed. Mechanism (verified against served bundle `index-Ca-11ol0.js`): `pluginContributionAvailable` in `src/client/src/components/PiWebApp.ts` returns false for every non-core plugin unless `verifiedPluginModeByMachine.get("local")` is "required"/"recovery-disabled" AND `requiredTerminalByMachine.has("local")`. Only the plugin-load paths set/delete those (boot-time for the local machine). A failed/exception gateway plugin load deletes them → every tab-strip render evaluates Files-only (`core` returns true unconditionally) → the mobile top-bar strip collapses to Sessions/Chat/Files + pinned Projects/Actions, exactly the reported screenshot. The failed load also resets `gatewayPluginLoadPromise`, so the NEXT route restore (i.e. the next session switch) re-runs `registerExternalPlugins`; if that retry fails too, the strip stays collapsed until an interaction coincides with a successful load.
- Fix committed-to-worktree (NOT yet committed to git — see below) in `src/client/src/components/PiWebApp.ts` on branch `fix/chat-scroll-fling-guard-tail` @ `b06ae336`: `ensureGatewayPluginsLoaded` now schedules a bounded automatic retry (5 attempts, 2s×attempt backoff, timer cleared on success and in `disconnectedCallback`) when a load completes incomplete; success resets attempts and ends in `invalidateWorkspaceSurface()`, which re-renders the strip with all tabs back.
- New test `retries a failed gateway plugin load automatically and restores the plugin mode (rbowen tasks-tab-collapse)` in `src/client/src/components/PiWebApp.pluginHost.test.ts` (fake timers; asserts retry runs without navigation and mode restored). Full file: 175/175 pass, typecheck clean.
- Reproduction notes for the record: 23 E2E runs against the deployed bundle could NOT reproduce the collapse (flow: `/tmp/e2e/tasks-timing8.js`) because the deployed app's boot loads now succeed; instrumentation (`tasks-timing6/7/9.js`) proved the switch path keeps 7 panels and the load memoized. The collapse requires the boot-load-failure precondition (slow/lossy plugin module fetch — realistic on rbowen's phone). Old repro scripts `tasks-collapse-repro3.js` captured it at 11:57/12:07.
- Deployed: `npm run build` produced `dist/client/assets/index-Cd6sn0AN.js`; copied `dist/client/.` into BOTH `~/.local/lib/node_modules/@jmfederico/pi-web/client/` AND `~/.local/lib/node_modules/@jmfederico/pi-web/dist/client/` (the server serves the latter; index.html now references the new bundle). Verified served `http://127.0.0.1:8504/assets/index-Cd6sn0AN.js` sha256 `adc69181b498e0e9…` = built file. No service restart needed (static swap, same as prior client deploys).
- Loki/journald check done (mandatory pre-push step): `journalctl --user -u pi-web.service` since 12:25 shows no errors/warnings beyond per-request noise. Loki only ships containers; pi-web is systemd, journald is its record.

## 4. In progress

Commit + push BLOCKED: `git commit` fails in a pre-commit hook — eslint on the test file reported 4 errors (`no-unsafe-call`/`no-unsafe-member-access` on `Reflect.get(app, "verifiedPluginModeByMachine").get(...)`). I applied the lint fix (typed cast `const modes = Reflect.get(app, "verifiedPluginModeByMachine") as Map<string, string>;` + two `modes.get(...)` asserts) but have NOT re-run the commit. Last `git push origin fix/chat-scroll-fling-guard-tail` reported "Everything up-to-date" (nothing committed yet); `git log` still `b06ae336`.

## 5. Next steps

1. `cd /home/rbowen/pi/pi-web-fork && npx eslint src/client/src/components/PiWebApp.ts src/client/src/components/PiWebApp.pluginHost.test.ts` — expect clean now.
2. Commit both files (`src/client/src/components/PiWebApp.ts`, `src/client/src/components/PiWebApp.pluginHost.test.ts`) with the prepared message: `fix(client): retry a failed gateway plugin load on a bounded backoff — a failed load deletes the verified plugin mode and terminal composition, collapsing the mobile tab strip to the core Files tab until some later navigation happened to retry (rbowen tasks-tab-collapse); each retry success ends in invalidateWorkspaceSurface() and re-renders the strip with all tabs`. If the hook fails again, run the hook's exact command to see the errors (they were swallowed by `tail -1`).
3. `git push origin fix/chat-scroll-fling-guard-tail` and confirm `origin` advances past `b06ae336`.
4. Deployed bundle already carries the fix; after push, no further deploy action needed. Untracked `handoffs/HANDOFF-2026-11-15-tasks-tab-collapse.md` in the fork worktree is mine (handoff docs); leave it untracked or commit per rbowen's convention (prior handoff `handoffs/voice-dictation-relay.md` was swept into a commit once).
