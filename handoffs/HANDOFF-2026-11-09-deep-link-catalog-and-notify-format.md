# HANDOFF — push tap still lands on home (server catalog stale); notification format change owed to rbowen

- Date: 2026-11-09, ~02:45 UTC. Box: vps-bdc7241d (ns3388744).
- Context: continuation of `HANDOFF-2026-11-09-session-deep-link.md` (deep-link fix shipped earlier, fan-out capped and deployed same night — see its Continuation section, commit `2a85adfd`).

## rbowen's asks this session (verbatim intent)

1. Tapping a "Task finished" notification "crashes out into the home screen" — still not landing in the chat. He asks whether we can test this properly on an emulated device.
2. Notification format (demanded three times on different agents, never shipped): TITLE = `hh:mm - Task Finished - <folder name>`, where `<folder name>` = whatever is CURRENTLY in the notification description (today the cwd basename, e.g. "pi"). DESCRIPTION/BODY = the session name — the individual task's name (`sessionTitle`), NOT the folder.

## Deep link — root cause FOUND, verified against the live system (not yet fixed)

The client logic is fine; the SERVER catalog data is stale/partial.

- Tapped session `01a1be08-3235-7687-87bb-c1ab6e920d5f` (cwd `/home/rbowen/pi`, completed 02:32:28Z, from `/api/machines/local/sessions/unread`).
- pi-web front catalog `GET /api/machines/local/projects/catalog`: project `pi` (path `/home/rbowen/pi`) exists, its main workspace lists 285 sessions, the tapped id is NOT among them → client `resolveRouteProjectForSession` (`PiWebApp.ts:1116`) correctly returns undefined → falls back to clearing selection into the project listing = the "home screen".
- Direct sessiond socket query: `curl --unix-socket /home/rbowen/.pi-web/sessiond.sock "http://localhost/sessions?cwd=%2Fhome%2Frbowen%2Fpi"` returns 304 sessions INCLUDING both tapped ids (`01a1be08…`, `01a1be1d…`). So sessiond has them; the front's catalog response does not.
- Catalog route: `src/server/app.ts:97` → `catalogWorkspaces` → `workspaceSessions` → `sessionDaemon.request("GET", "/sessions?cwd=…")` (`app.ts:126`). No cache in the route itself. Daemon interface: `src/server/sessiond/sessionProxyRoutes.ts:10`; implementation `SessionDaemonClient` at `src/sessiond/sessionDaemonClient.ts:34`.

### Where the investigation stopped (do this next)

- Key timing fact: pi-web.service (front) restarted 02:16:36; pi-web-sessiond restarted 02:24:59 (NOT by me — concurrent agent or rbowen). The front's connection to sessiond PREDATES the sessiond restart. A stale front→sessiond channel serving old data (285 vs 304) fits perfectly.
- FIRST check: read `src/sessiond/sessionDaemonClient.ts` end to end for connection reuse/snapshot behavior. THEN: restart pi-web.service (front only — safe, no agent sessions), re-fetch the catalog, re-check for `01a1be08`. If it appears, root cause = stale front↔sessiond channel after sessiond restart; then decide the durable fix (reconnect/retry on socket change, or catalog busting) rather than accepting "restart the front after sessiond" as the procedure.
- If the front restart does NOT fix the catalog, diff the front's 285 vs sessiond's 304 id lists to find the filter (per-request filter in `workspaceSessions`, response interception in the client, or a serialization cap).

## Notification format — what to change and why rbowen never saw it

- Rendering lives in box-launcher (`/home/rbowen/pi/box-launcher`), NOT pi-web. Earlier agents only added `sessionTitle` to the FCM payload (`eae9e515`, `fcmPushService.ts` `deliver()` already sends `title: "Task finished"`, `body` = cwd basename, `sessionTitle`, `completedAt`, `url`). The launcher already prefers `sessionTitle` for the body (`push_notify_controller.dart` `notificationForData()`), but rbowen still sees the folder because (a) the title was never given the folder suffix, and (b) sessiond sessions currently carry `title: None` (verified in the socket dump — every sampled session has no title), so the body falls back to the cwd basename.
- Server: to honor "THE ACTUAL TASK NAME" in the description, the payload's `sessionTitle` must actually be populated for his sessions. Trace `event.unread.title` upstream (`fcmPushService.ts` `deliver()` gates on `event.unread.title !== undefined`) and find why it is empty (sessiond session title never set?). If sessions genuinely have no title, decide with rbowen what the fallback should be — do not silently keep the folder.
- Launcher edits needed (all in `/home/rbowen/pi/box-launcher`): `lib/domain/local_notification.dart` `taskFinishedTitle()` gains the folder suffix; `lib/app/push_notify_controller.dart` `notificationForData()` passes `data['body']` (cwd basename) into the title and keeps `sessionTitle` as the body; `lib/app/task_notify_controller.dart` (F7 live-socket/backfill path) same title change using the event's cwd basename. `notificationForData` is shared with the background isolate via `lib/adapters/firebase_push_adapter_io.dart:82`, so one edit covers terminated-state taps.
- Delivering ANY launcher change requires rebuilding the APK and rbowen installing it — that is why three prior demands "never landed": nothing ever reached his phone. Flutter is at `/home/rbowen/flutter/bin/flutter`; check the box-launcher repo for build/install docs and existing tests (`test/f9_push_notify_test.dart` asserts the current title format — update it).

## Emulator / proper testing (rbowen explicitly wants this)

- `/dev/kvm` EXISTS on this box; flutter exists; no adb/Android SDK found yet (`which adb` empty).
- Feasible: install Android SDK cmdline-tools + a Google-APIs system image (FCM needs Play services), create an AVD, build the box-launcher APK, drive the tap path with adb. Cost: multi-GB downloads, roughly an hour of setup. Headless `flutter test` covers the notification mapping logic without a device meanwhile; jsdom tests already cover the web deep-link resolution.

## Warnings

- A concurrent agent session is active in pi-web-fork (its commit `4d469963` appeared mid-work; it restarted sessiond 02:24:59). Re-check `git log` before pushing.
- Deployed client bundle is `index-CVx0YpbH.js` (deletion-sweep gate + terminal reload cap, tested, pushed). Front restart also re-serves whatever the concurrent agent builds — coordinate.
- Untracked stray `~/pi/pi-web-fork/jmfederico-pi-web-1.202610.0.tgz` — not mine, left alone.

## Re-detect / verification commands

- Catalog staleness: compare `curl -s http://127.0.0.1:8504/api/machines/local/projects/catalog | python3 -c "import json,sys; c=json.load(sys.stdin); print(sum(len(w.get('sessions',[])) for p in c['projects'] for w in p['workspaces'] if w['path']=='/home/rbowen/pi'))"` vs `curl -s --unix-socket /home/rbowen/.pi-web/sessiond.sock "http://localhost/sessions?cwd=%2Fhome%2Frbowen%2Fpi" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"`.
- sessiond timeouts: `journalctl --user -u pi-web-sessiond --since '-30 min' --no-pager | grep -c 'timed out after 10000ms'`.
