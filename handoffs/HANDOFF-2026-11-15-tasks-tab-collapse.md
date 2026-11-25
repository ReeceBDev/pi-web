# Handoff — Hephaestus tasks-tab collapse on session switch

## 1. Original prompt (verbatim)

"In hepheastus, switching between sessions causes the sessions tasks tab to collapse.
Investigate, rectify, deploy, push"

## 2. Total request (verbatim)

"In hepheastus, switching between sessions causes the sessions tasks tab to collapse.
Investigate, rectify, deploy, push"

(No further user input; the two later images were my own screenshots attached by tool results.)

## 3. Work done so far

- Located the project: pi-web fork at `/home/rbowen/pi/pi-web-fork`, branch `fix/chat-scroll-fling-guard-tail` @ `b06ae336`. Served live on port 8504 (pi-web.service), installed package `~/.local/lib/node_modules/@jmfederico/pi-web`. Served client bundle = `ab72533f` (`index-Ca-11ol0.js`); later commits `e3a58fab`/`3107e410` are NOT deployed. The reported session itself is my own pi-web chat (01a1df07…), no prior diagnosis exists anywhere.
- "Tasks tab" = the Workspace Tasks plugin tab (`workspace-tasks:workspace.tasks`, `pi-web-plugins/workspace-tasks/`). On mobile (rbowen's Android, 390px) the top bar IS the tab strip (`app-mobile-main-tabs`): Sessions, Chat, then plugin tabs, with Projects/Actions pinned right.
- Killed the obvious theory: prior fix `e82244c8` (session switch keeps workspace tool) is present and works. Playwright repro (desktop and mobile) shows the URL keeps `tool=workspace-tasks:workspace.tasks&view=chat` after switching sessions, and the desktop workspace panel stays on the Tasks tab.
- Actual observed defect (mobile): after switching sessions, the rendered strip loses the plugin tabs Terminal/Tasks/Updates (and others) — only Sessions/Chat/Files plus pinned Projects/Actions remain; the gap between Files and Projects in `/tmp/e2e/tc3-3-after-switch.png` proves they are absent from the DOM, not scrolled away. Tapping Tasks again re-renders and all tabs return (`/tmp/e2e/tc3-5-tasks-retap.png`).
- Plugin registry is NOT the problem: `app.plugins.getWorkspacePanels()` returns the full stable list `Files,Git,Terminal,Tasks,Updates,Info,Sounds` at every sample (boot through +7.5s after switch). So the drop is a RENDER-time effect (a render fired while `visibleWorkspacePanels()` evaluated empty/partial, then no later state change re-rendered the strip; the next interaction re-renders and restores tabs).
- E2E scripts written: `/tmp/e2e/tasks-collapse-repro.js`, `-repro2.js`, `-repro3.js`, `-desktop.js`, `tasks-probe-state.js`, `tasks-probe-prefs.js` (hiddenIds ruled out), `tasks-timing.js/-2/-3`, `strip-structure.js`. Playwright: `playwright-core` + headless shell at `/home/rbowen/.cache/ms-playwright/chromium_headless_shell-1243/...`, Android UA, viewport 390x844, target `http://127.0.0.1:8504/`.

## 4. In progress

`/tmp/e2e/tasks-timing3.js` — written, NOT yet run. It deep-finds `app-mobile-main-tabs` (it lives inside shadow roots; `document.querySelector` finds nothing — use the script's `deepFind`) and samples the RENDERED strip button labels at boot and at +300ms…+7.5s after switching sessions, alongside the registry panel list. Purpose: catch the render where tabs vanish and see whether they return on their own (transient render race) or stay gone until interaction (stuck render).

## 5. Next steps (this run's remit: investigate → rectify → deploy → push)

1. Run `cd /tmp/e2e && node tasks-timing3.js`. Read the timeline: which renders show a reduced tab list, and whether tabs return without interaction.
2. If tabs return on their own: transient; find the late render that drops them. If they stay gone until interaction: confirm the stuck-render theory — some render during the session-switch restore ran while `visibleWorkspacePanels()` was empty/partial (e.g. `state.selectedWorkspace` briefly undefined mid-restore, or plugin contributions mid-reload), and nothing scheduled a re-render afterwards.
3. Fix in `~/pi/pi-web-fork` (branch `fix/chat-scroll-fling-guard-tail`), laziest correct option; likely candidate: schedule a re-render when plugin panels become available again (e.g. a `this.requestUpdate()` after `finishWorkspaceRouteRestore`/plugin-load completion, or make the strip re-evaluate panels on route-restore completion). Check `renderMobileMainTabs` in `src/client/src/components/PiWebApp.ts` (~line 3514) and the restore flow (`restoreRouteFor` ~line 731, `finishWorkspaceRouteRestore` ~line 880).
4. Add/extend one test in `PiWebApp.pluginHost.test.ts` style that fails on the reduced-strip render and passes with the fix.
5. Deploy = static swap of the built client bundle into `~/.local/lib/node_modules/@jmfederico/pi-web` (pattern recorded in `/opt/vps-1-infra-repo/INDEX.md`; prior client deploys need no service restart). Verify served URL then shows full strip after session switch (rerun the repro against 8504).
6. Before pushing: Loki check is mandatory per project instructions (check pi-web logs around the repro for plugin-load/render errors), then commit and push to origin `fix/chat-scroll-fling-guard-tail`.
7. Untracked file `agentic-workflow/HANDOFF-download-preview-bin-filename.md` exists in the fork worktree — not mine, leave it alone.
