# Handoff — pi-web side of pipeline "+ New Work" run launch

## 1. User's original prompt (verbatim)

"Implement the pi-web side of the owner-approved pipeline launch in THIS repo (/home/rbowen/pi/pi-web-fork, branch fix/chat-scroll-fling-guard-tail). Read /home/rbowen/pi/pipeline/docs/ALIGNMENT-CONTRACT.md first — it is the locked contract (sections "The wire" and "pi-web side" are yours); do not redesign it.

Deliver:

1. SERVER ROUTE: new machine-local route POST /pipeline-runs, body {repoPath, goal, sketches: [absolute file paths]} → {ok: true, projectRunId} or {ok: false, reason, detail}. Implementation: validate repoPath (exists, absolute); spawn the CLI per contract: node /home/rbowen/pi/pipeline/dist/scripts/start-run.js --repo <repoPath> --goal-file <tmpfile with goal> --sketch <each path> --actor rbowen; parse the last stdout line as JSON; map exit codes. Mirror the structure/security posture of the existing supervisor routes (src/server/machines/supervisorRoutes.ts + unitSupervisorClient.ts are the precedent — read them first; reuse their local-trust gating pattern, machine-local only). No new dependencies. Write the goal tmpfile via the server's existing temp-file conventions if any, else os tmpdir with cleanup.

2. CLIENT FLOW — "+ New Work" pipeline mode: read src/client/src/controllers/sessionController.ts first (workspaceForNewSession, pending session starts, the first-message gate). Target behavior: pressing "+ New Work" opens the chat row INSTANTLY on the repo workspace (no supervisor unit-creation call, no worktree wait — faster than today). The FIRST message send (text + any attachment file paths already on disk server-side) triggers the run: client calls the new route; the ack (projectRunId) renders in the chat as a system-style note; the message is NOT prompt-fed into a backing pi session. Normal chats and "+ Non-Sandboxed" keep today's exact behavior. Machine-local gate: pipeline mode only when machineId is local (same gate as the supervisor unit path today). If chat attachments are not available server-side as file paths in the current UI, wire text-only and note it — do not build an upload pipeline.

3. PATCH PIPELINE CHECK: served client files may be patched via /home/rbowen/pi/pi-web-customisations/apply-patches.py (CACHE_VER bumps) — inspect it; if the components you touched are among the patched served files, extend the patch there with CACHE_VER bump; plain src/ changes alone are not deployment for served files.

TESTS: repo has vitest suites next to the code (e.g. sessionController.pendingStarts.test.ts, app.supervisor.test.ts). Add/extend: route test (stub CLI via injectable command path or env override — success, CLI failure, bad repoPath); controller test (pipeline pending start: no supervisor call, first send hits the route, normal flow untouched). Run the TARGETED test files only (npx vitest run <files>), report results. Do NOT run the full suite if it is slow; run at least the files you touched plus ones importing them.

HARD RULES: never restart or kill pi-web-sessiond or any live service (a restart kills every live chat — owner-only action); do not git push; commit to the current branch with a normal commit message; do not touch handoffs/* untracked files; smallest working diff; reuse existing api client/controller patterns (grep before writing).

FINAL OUTPUT: files changed (one line each), targeted test output tail, how the contract's "pi-web side" items are satisfied, and anything deliberately skipped. If blocked by a concrete obstacle, state it in one line and stop."

## 2. User's total request throughout the conversation

Same single request (no follow-up messages in this session).

## 3. Work done so far

All implementation, tests, lint, and typecheck are DONE. Only the final test re-run and the commit remain.

### Files changed (all in /home/rbowen/pi/pi-web-fork, branch fix/chat-scroll-fling-guard-tail)

- `src/server/machines/pipelineRoutes.ts` (NEW) — `POST /api/pipeline-runs` route + `ChildPipelineRunClient` spawn client + `PipelineRunDelegate` interface. Validates body via type guards (`parseRunBody`/`validate`: repoPath absolute+exists+dir, goal non-empty, sketches string[] of absolute paths); spawns `process.execPath <scriptPath> --repo <repoPath> --goal-file <tmpfile> [--sketch <p>]... --actor rbowen`; scriptPath = `options.scriptPath ?? env PI_WEB_PIPELINE_START_RUN ?? "/home/rbowen/pi/pipeline/dist/scripts/start-run.js"`; goal written to `mkdtemp(os tmpdir + "pi-web-pipeline-goal-")/goal.txt`, removed in `finally`; parses last non-empty stdout line as JSON; exit 0 + `{ok:true,projectRunId}` → ok; exit 0 + garbage → `{ok:false, reason:"invalid_cli_output"}`; nonzero + `{ok:false,reason,detail}` → passthrough; otherwise `{ok:false, reason:"cli_exit_<code>"}`; spawn throw → `{ok:false, reason:"cli_spawn_failed"}`. Invalid input → HTTP 400 `{ok:false, reason:"invalid_input"}`; CLI ran → HTTP 200 with ok flag. Machine-local by construction (plain app route, never under the `/api/machines/:id` proxy — same posture as supervisorRoutes). No new dependencies.
- `src/server/app.ts` — import + `pipelineRunner?: PipelineRunDelegate` dep + `registerPipelineRoutes(app, deps.pipelineRunner)` right after `registerSupervisorRoutes`.
- `src/server/app.testSupport.ts` — `pipelineRunner` slot on AppTestContext/appTestContext, reset in beforeEach, `delegatingPipelineRunner()` passed to buildApp (mirrors delegatingUnitSupervisor).
- `src/server/app.pipeline.test.ts` (NEW) — 6 tests using appTestContext + a generated stub start-run script (records argv+goal content to a file, success/fail via STUB_MODE env): success ack + exact argv/goal assertions; CLI failure passthrough; relative repoPath → 400 with fake delegate counting 0 spawns; nonexistent repoPath → 400; empty goal → 400; `PI_WEB_PIPELINE_START_RUN` env override resolution via direct ChildPipelineRunClient.
- `src/client/src/api/parsers.ts` — `export type PipelineRunAck` + `parsePipelineRunAck` (ok:true+projectRunId, else ok:false with reason/detail defaults).
- `src/client/src/api/clients.ts` — `pipelineApi.pipelineRun(repoPath, goal)` → `request("api/pipeline-runs", parsePipelineRunAck, POST)`; re-export of PipelineRunAck type; spread into `api`.
- `src/client/src/controllers/sessionController.ts` — (a) `startSession` options gain `pipeline?: boolean`; pipeline is machine-local gated (`options.pipeline === true && machineId === "local"`); pipeline pending start skips `rememberCachedNewSession`, navigation freshness, and the `api.startSession` call entirely — row is client-side-only and ephemeral (gone on reload); (b) `workspaceForNewSession(cwd, plain, pipeline)` — pipeline returns the repo workspace with zero supervisor calls (plain/remote/unit-worktree/startSessionAt unchanged); (c) `PendingSessionStart` gains `pipeline?` + `pipelineLaunchAttempted?`; (d) `enqueuePendingSessionSend` calls `maybeLaunchPipelineRun` for the first prompt; (e) `launchPipelineRun`/`appendPipelineLines` — appends optimistic user line, calls `api.pipelineRun(pending.cwd, goal)`, renders `system` note `Pipeline run started · <projectRunId>` or `Pipeline run failed · <reason> · <detail>` (or HTTP error message) into `state.messages` when the row is selected; failed launch resets `pipelineLaunchAttempted` so the next send retries; launched queued entry spliced from `pending.queuedSends` + `dropNextQueuedSessionMessage`.
- `src/client/src/components/PiWebApp.ts` — `startSessionAndOpenChat` passes `pipeline: !plain && path === undefined` (covers nav "+ New Work", plugin action `startSession`, and the `withChatScrollTransition` hook; path-based starts like sessions-bar unit chats stay backend sessions).
- `src/client/src/components/PiWebApp.pluginHost.test.ts` — one test ("recovers a pending start after focus and a later view change") now calls `startSessionAndOpenChat(undefined, workspace.path)` (path variant) because the no-path entry is now a pipeline launch; comment added in test.
- `src/client/src/controllers/sessionController.pipeline.test.ts` (NEW) — 5 tests: instant row with zero supervisor/startSession/pipelineRun calls; first send hits route (`("/repo", goal)`), renders user+system lines, drops queued preview, never calls `api.prompt`; failed launch renders reason and next send retries (2 calls); plain flow unchanged (startSession called, no supervisor); default no-flag flow unchanged (supervisorUnit+supervisorCreateUnit+startSession with startupToken).
- OUTSIDE THIS REPO (uncommitted, owner's call): `/home/rbowen/vps-1-infra-repo-wt-wake-notify/pi-web-customisations/apply-patches.py` — CACHE_VER bumped `wsfix11` → `wsfix12` (task path `/home/rbowen/pi/pi-web-customisations/` does not exist; this is the real script location, found via find). Rationale: touched client files compile into the served entry `index-*.js`; no BUNDLE_PATCHES anchor overlaps changed code, so no new patch entry, but entry bytes change so the cache-bust version must bump before next deploy.

### Verification status at handoff

- `npx tsc --noEmit -p tsconfig.json` — CLEAN (run after last edit).
- `npx eslint` on all touched files — CLEAN (run after last edit).
- Targeted vitest run of 13 files (`app.pipeline`, `sessionController.pipeline`, `pendingStarts`, `cachedNew`, `sendQueue`, `startupProgress`, `startupDialogs`, `clients.test`, `parsers.test`, `PiWebApp.pluginHost.test`, `app.supervisor`, `app.machines`, `app.localAliases`) — passed 352/352 BEFORE the final two cosmetic route-file fixes (optional-chain, `return await`, `parseRunBody`/`isStringArray` refactor). tsc+eslint confirm those compile, but the post-fix vitest re-run had NOT executed when this wall hit.

## 4. What was just in-progress

The final confirmation command (blocked by context wall before it could run):

```
cd /home/rbowen/pi/pi-web-fork && npx vitest run src/server/app.pipeline.test.ts src/client/src/controllers/sessionController.pipeline.test.ts src/client/src/controllers/sessionController.pendingStarts.test.ts src/client/src/controllers/sessionController.cachedNew.test.ts src/client/src/controllers/sessionController.sendQueue.test.ts src/client/src/controllers/sessionController.startupProgress.test.ts src/client/src/controllers/sessionController.startupDialogs.test.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts src/client/src/components/PiWebApp.pluginHost.test.ts src/server/app.supervisor.test.ts src/server/app.machines.test.ts src/server/app.localAliases.test.ts
```

Expected: all pass (352+ tests). If any failure, it will be in `src/server/app.pipeline.test.ts` from the last route refactor.

## 5. What the next agent should do (this run only)

1. Run the vitest command in section 4; fix any fallout in `src/server/app.pipeline.test.ts` (only file logically affected by the last refactor).
2. Review `git status` in /home/rbowen/pi/pi-web-fork; stage ONLY the files listed in section 3 (NEVER `handoffs/*` — they are untracked and must stay untouched, including this file) and commit on branch `fix/chat-scroll-fling-guard-tail` with a normal message, e.g. `feat: launch pipeline runs from + New Work first message (POST /pipeline-runs)`.
3. Do NOT git push. Do NOT restart pi-web-sessiond or any service (hard rule). No service restart is needed for these changes on the dev box anyway (web/API + Vite autoreload; sessiond untouched).
4. Report to user: files changed (section 3), test tail, contract satisfaction — "The wire": route spawns CLI with exact contract argv, last-stdout-line JSON, exit-code mapping, goal tmpfile with cleanup; "pi-web side": + New Work instant row (no supervisor call/wait), first send POSTs run, ack rendered as system note, message never prompt-fed, normal/+ Non-Sandboxed untouched, machine-local gate, patch pipeline checked with CACHE_VER bump. Deliberately skipped: attachment file paths (PromptAttachment is base64 client-side data, no server-side path exists — wired text-only per task instruction); pipeline rows are ephemeral client-side rows (not persisted, gone on reload, no session persistence); queued sends after the first stay queued (only the first prompt launches the run); `/`-commands and shell input on a pipeline row just queue. Note: `/home/rbowen/pi/pipeline/dist/scripts/start-run.js` does not exist yet (pipeline side builds it); the route returns ok:false cli_spawn_failed until then — tests stub the CLI.
