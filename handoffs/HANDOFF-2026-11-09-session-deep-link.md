# HANDOFF — box-launcher notification tap should land in the chat (pi-web client fix shipped; server jam parked)

- Date: 2026-11-09, ~02:00 UTC. Box: vps-bdc7241d (ns3388744).
- Ask (rbowen): tapping a "Task finished" notification on Android (box-launcher) opens Hephaestus but sits on a loading state instead of opening the one chat. Investigate and fix.

## What was done (shipped, live)

1. **Client deep-link fast path — FIXED.** Push taps open `https://hephaestus.divinearts.co.uk/?session=<id>&view=chat` (built in `pi-web-fork/src/server/webPush/fcmPushService.ts` `deliver()`; box-launcher builds the same link in `box-launcher/lib/app/task_notify_controller.dart` `deepLinkFor`). The client's route restore (`PiWebApp.ts` `restoreRouteFor`) ignored a session with no `project`/`workspace` param: it cleared the selection and showed the project listing. Fix: new `resolveRouteProjectForSession(sessionId)` maps the session id to its project and workspace from catalog state already in memory (`state.sessionsByWorkspacePath`, `state.workspacesByProjectId`, populated by the one-shot `/api/machines/local/projects/catalog`), then selection proceeds through the normal `selectProject` path — all local, no extra fetches. Falls back to the old listing behavior when the catalog does not contain the session (very old sessions). Commit `79bb86e7`, includes regression test in `PiWebApp.pluginHost.test.ts` ("resolves a session-only deep link…"). Full client suite green: 193 files / 2003 tests; `npm run typecheck:cached` clean.
2. **Deployed.** Procedure for this host-native service: in `~/pi/pi-web-fork` run `npm run build`, then `rsync -a --delete dist/ /home/rbowen/.local/lib/node_modules/@jmfederico/pi-web/dist/`, then `systemctl --user restart pi-web.service` (web/API only — pi-web-sessiond was NOT restarted, agent sessions unaffected). Verified live: served bundle is `index-BX1PILTZ.js` and contains the new function (`grep -c resolveRouteProjectForSession` = 1 in the installed dist asset); `/api/machines/local/sessions/unread` answers 200 in 3 ms. box-launcher needed no changes; its F7 tap path was already correct.

## Root cause of the slowness (verified in journal, NOT yet fixed — parked)

Window 2026-11-09 01:00:34–01:02:09, `journalctl --user -u pi-web`:

- A reconnecting browser tab fired a per-workspace fan-out: dozens of `POST /api/paired-plugin-backends/pi-web.terminal/projects/<pid>/workspaces/<wid>/terminal.list-runs` (plus `terminal.list`, file trees, transcripts) across ALL workspaces of TWO projects.
- sessiond then logged repeated `Workspace provider git list timed out after 10000ms` (pluginId `git`, tier `fallback`, operation `list`, stack through `workspaceProviderRegistry.js` `runBoundedProviderOperation`) — ~11–12 s per timed call, one per workspace batch.
- The phone's cold-boot wave (01:00:55, identified by its `POST /plugins-api/box-push/subscribe` FCM registration) queued behind that storm and completed 56–85 s later. That queue wait is the "load sessions" delay rbowen sees. Related history: `handoffs/FINDINGS-sessions-list-flood.md` (GET /sessions?cwd flood, went dormant after a 2026-11-08 17:31 restart).

To finish this: trace which client component issues terminal.list-runs for every workspace on tab reconnect (TerminalPanel only fetches its own visible workspace scope, so the caller is elsewhere — candidates: required-terminal facade bindings, workspace panel reconciliation, or a keeps-alive panel per workspace). Cap it to the selected/visible scope. Consider whether the git workspace-provider list (10 s bound) should be cheaper or cached (note commit `4ee25cae` reverted a 30 s shared unit-scan cache back to 3 s per caller — read that history before caching again). Re-detect recurrence with: `journalctl --user -u pi-web-sessiond --since '-30 min' --no-pager | grep -c 'timed out after 10000ms'`.

## Warnings for the next agent

- **A second agent session was working in this repo concurrently** (commits `eae9e515` 01:27 push sessionTitle, `4ee25cae` 01:43 revert git-plugin cache, deploy 01:44:53). My deploy (~01:56) shipped both. Working tree was clean at handoff except this file.
- **Commits are local to this box** — `main` was NOT pushed at handoff time. Per standing rules unpushed work must not stay deployed-invisible: push `main` to origin first thing.
- pi-web.service was restarted twice during the work (01:41, ~01:56). sessiond was not restarted and holds 2h+ of agent sessions.

## Verification rbowen can do

Send himself a task-finished push (or wait for the next one), tap it: Hephaestus should open straight into that chat within a couple of seconds on a quiet server. If it still lands on the listing, check whether the tapped session id exists in `/api/machines/local/projects/catalog` (fallback path) and check `pi-web` journal for the jam storm above.

## Continuation 2026-11-09 ~02:20 UTC — fan-out traced and capped (shipped)

Both client-side causes of the jam are fixed, tested, committed (`1acfeefa`, `9f923d8e`), pushed (`736a8845..9f923d8e main`, includes concurrent agent's `4d469963`), built, and deployed: served bundle `index-CVx0YpbH.js` contains the sweep gate; pi-web.service restarted 02:16:36 (sessiond untouched).

1. **Deletion-sweep fan-out (the parked jam).** `PiWebApp.refreshWorkspaceDeletionRuns()` swept `terminal.list-runs` across every workspace of the selected project on every browser resume and route restore, even with nothing tracked. During a sessiond jam each call ran ~10s, queued refreshes re-fired the sweep, and phone boots queued 56-85s behind it. Fix: discovery runs once per machine+project+workspace-set key; tracked pending runs still poll narrowly; a failed sweep clears the key so the next resume retries. Regression test in `PiWebApp.pluginHost.test.ts`.
2. **Terminal list hot loop (found while tracing).** `TerminalPanel.shouldReloadForRequestedTerminal()` refetched `terminal.list` on every render while the URL's requested terminal id was missing from the list and `navigation.set` rejected (observed live: 264 requests in ~3 min for one workspace). Fix: capped at 3 reloads per requested id; counter resets when the id or workspace changes. Regression test in `TerminalPanel.test.ts`.

Verified after deploy: the 1.1s `terminal.list` loop stopped (0 requests in 2 min), sessiond `timed out after 10000ms` count is 0 for the last 5 min (was 185 in the prior 30). Full client suite green (5025 tests), typecheck and lint clean.

Still open (rbowen's call): sessiond's per-call git worktree listing can still take 10s. The concurrent agent's `4d469963` (read unit worktree origin/branch from repo files instead of spawning git) is in the deployed dist but pi-web-sessiond was not restarted, so it is not loaded. A sessiond restart would activate it and interrupt live agent sessions. Re-detect recurrence with: `journalctl --user -u pi-web-sessiond --since '-30 min' --no-pager | grep -c 'timed out after 10000ms'`.
