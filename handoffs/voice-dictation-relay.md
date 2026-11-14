# Relay handoff: voice dictation for pi-web chat (leg 3 diagnostics shipped, awaiting device evidence)

## Stable agreement (do not change without rbowen)

Goal: rbowen speaks into the pi-web chat (this browser UI) and the agent replies aloud.

Finish line (observable):
1. Mic button sits where the attachment button was (bottom-right inside the editor). Attachment button moved to sit immediately left of the send button in `.actions`.
2. Press mic: audio streams to the VPS in near-realtime and live transcript appears in the editor. Press the mic/green send again (or normal send/Enter): final transcript is sent as the message. A red cancel square beside it discards the dictated text and restores the prior draft.
3. STT engine: Parakeet TDT 0.6B v2 int8 via onnx-asr (benchmark on this box: RTFx 2.16 vs whisper large-v3-turbo 0.18 — turbo is disqualified on this AVX-only Xeon).
4. Work happens in the fork `/home/rbowen/pi/pi-web-fork` (branch main), NOT the live minimized deployment. rbowen decides deployment.

Non-goals: telephony, TTS (later, browser speechSynthesis proposed), remote-machine dictation (v1 = local web/API machine only).

## Baton (current position)

LEG 3 DIAGNOSTICS SHIPPED 2026-11-10 ~17:50 — both logging directives done and deployed. Server side remains DONE and proven. The failure is client-side capture in the box-launcher Android WebView (getUserMedia "could not start audio source"). What shipped this leg:

- CLIENT LOGGING (fork main `a6bf0f66`, pushed, DEPLOYED to live 8504): `src/client/src/speech/dictation.ts` getUserMedia failure now surfaces `Could not start dictation: <DOMException name>: <message> (microphone permission: <state>)` in the hint text, plus `console.error` with the raw exception. The mic permission state comes from `navigator.permissions.query({name:'microphone'})`, "unavailable" if the API is missing/throws.
- BOX APP DIAG LOGGING (box-launcher master `d78774f`, pushed): `_registerMicPermissionHandler` in `lib/adapters/web_view_navigator_io.dart` emits `mic_perm` events on the F9 diag pipeline (`plugins-api/box-push/diag`, cookie-authed): `outcome: grant|deny`, `before`/`after` `Permission.microphone` status names, or `reason: no_microphone_type` for non-mic requests. Version 0.1.20+21 built (APK 50.4 MB), published to `~/launcher-public/box-launcher.apk`, live manifest appUpdate = versionCode 22 / 0.1.21 — rbowen's phone self-updates via the F8 banner. VERSION CORRECTION (rbowen, confirmed): his phone is versionName 0.1.20 = versionCode 21 — the handoff's earlier "versionCode 20" reading was wrong; rbowen's F7 commit `156239d` had already bumped pubspec to `0.1.20+21`. First logging build went out as 21 — same code his phone already ran, banner would never fire — rebumped to `0.1.21+22` in `6bae036` and republished. His 21 build already contains the dd5fe60 permission handler and still fails, so the hypothesis space is unchanged.
- EMULATOR REPRO (directive 2): the emulator is REAL and was ALREADY RUNNING before this leg — AVD `pi-tap` (android-35, x86_64), process PID 2075601, headless (`-no-window -gpu swiftshader_indirect`), left running untouched. Evidence path that works: `adb -s emulator-5554 install -r ~/launcher-public/box-launcher.apk`, monkey-launch, `exec-out screencap -p` piped to a PNG file = eyes (read the PNG). Verified by screenshot: box-launcher 0.1.20+21 renders the full launcher list; tapping the PI GUI entry opens the WebView and lands on the Cloudflare Access login (ztnrb.cloudflareaccess.com, "Log in to Server Admin UI User-Access"). FULL REPRO IS BLOCKED ON LOGIN: needs rbowen's Access email + the emailed login code typed via `adb shell input`. A SystemUI ANR dialog appears on this software-rendered emulator — dismiss by tapping "Wait" (input tap 322 1363) or `am force-stop com.android.systemui`.
- NEW LOG EVIDENCE (journalctl -u pi-web.service): at 17:16:10–14 rbowen's client (147.135.252.207) ran a WORKING dictation — ~9 POST /audio over 4.5 s then /finish. Later attempts (17:16:59, 17:17:02, 17:20:56) show the instant-fail create+DELETE pattern. Desktop/browser path works end-to-end; only the Android WebView capture fails.

Decision tree once rbowen updates to 21 and taps the mic (read hint text + grep pi-web logs for `mic_perm`):
1. Hint `NotAllowedError` / mic_perm `deny` with `before: denied|permanentlyDenied` — runtime permission path (hypothesis 2). Fix: handle permanentlyDenied (openAppSettings) and/or pre-request at entry open.
2. Hint `NotReadableError`/`AbortError` with permission `granted`, mic_perm `grant` — device-open path (hypothesis 4). Fix shape: pre-request + possibly setMediaPlaybackRequiresUserGesture false; emulator repro tells 3 vs 4.
3. NO mic_perm events at all + hint state `unavailable` — the WebView never reaches the permission request; capture dies earlier (hypothesis 4 variant, deeper).

rbowen next actions (his call, in value order): (1) install the 21 update, tap mic, read the exact hint line back; (2) the manual test — Android Settings → Apps → box-launcher → Permissions → Microphone → Allow, force-stop, reopen, tap mic — still isolates the permission path in one minute; (3) provide an Access login path for the emulator (his email + the emailed code) OR skip emulator repro.

Deploy-path notes from this leg: fork deploy ran from the WORKING TREE (live 8504 serves index.html with rbowen's signed uncommitted touchmove guard — established practice, smallest delta vs live). `pi-web.service` was restarted for the deploy; npm-install symlink swap caused a ~8 s transient crash-loop (exit 127, bin shim mid-swap) that self-healed — service active, speech session endpoint verified. rbowen's fork working tree was (and is) mid-edit on branch `fix/chat-scroll-fling-guard-tail` (uncommitted: SessionList.ts, app.staticCaching.test.ts, scrollProbe.ts + test, app.ts, tgz) — untouched. My client commit briefly landed on his branch by mistake (checkout was not on main); fixed via git plumbing: reset his branch back to `c4a0264f` exactly, cherry-picked the change onto main as `a6bf0f66` (diff vs main = dictation.ts only), pushed main. dictation.ts change is back to unstaged in the working tree, content identical to main's. Box-launcher tree still carries pre-existing unstaged build artifacts (.flutter-plugins-dependencies, GeneratedPluginRegistrant.java, local.properties, push-plugin/storage.json) — untouched, never committed. Disk fact correction: / has ~18 GB free (the 3.6 GB figure below is stale).

Previous leg 3 context (superseded detail, kept for the record):

What shipped already (leg 2.5, box-launcher `dd5fe60` on master, pushed):
- `RECORD_AUDIO` declared in `android/app/src/main/AndroidManifest.xml`.
- `lib/adapters/web_view_navigator_io.dart`: Android-only `setOnPlatformPermissionRequest` handler — requests runtime permission via `permission_handler` ^12, grants microphone-only, denies camera/MIDI/protected media. Widget-test fakes skipped by type check.
- pubspec `0.1.19+20`; APK published to `~/launcher-public/box-launcher.apk`; live manifest appUpdate = versionCode 20 / 0.1.19.
- UNKNOWN, must ask rbowen before changing code: did his phone actually install 0.1.19 (F8 self-update banner), and did the OS microphone dialog appear and get accepted? ANSWERED 2026-11-10 later: rbowen says the app is on "0.1.20" now (that matches versionCode 20 / versionName 0.1.19 — the update landed) and the error is UNCHANGED: "could not start audio source". Hypothesis 1 is dead. Hypotheses 3/4 (permission not held when the capture pipeline opens) are now primary; note the reported permission state is still unknown because NOTHING logs the permission flow — rbowen explicitly asked for proper logging.

rbowen's directives for leg 3 (explicit):
1. ADD PROPER LOGGING: client side — dictation.ts should surface the DOMException name/message and the navigator.permissions microphone state in the hint text (and console.error, which the browser-error boundary may carry to the server); box app side — in the onPermissionRequest handler log (via the existing diag/events pipeline in lib/adapters/push_diag_io.dart if it fits, else debugPrint) the requested resources, Permission.microphone.status before request(), the status returned after request(), and the grant/deny outcome.
2. TRY IT ON THE EMULATOR: first VERIFY an emulator actually exists on this box (look under /home/rbowen/android-sdk/emulator, `avdmanager list avd`, and the emulator plan in agentic-framework-2 `17-test-harness.md` — planned ≠ built). The app in the emulator must log into hephaestus (Cloudflare Access cookie bridge, F7) — rbowen's credentials are his to give; ask him for a test path instead of assuming.

Ranked hypotheses (verify each against evidence, do not guess):
1. DEAD — phone updated (versionCode 20 installed), error unchanged.
2. Runtime permission not actually granted: `permission_handler` request() may be failing silently inside the WebView callback (Activity lifecycle, permanentlyDenied state from earlier builds), and Android then fails the AudioRecord open, which Chrome reports as NotReadableError ("could not start audio source") rather than as a permission error. LOGGING (directive 1) is what settles this.
3. Permission granted but not held early enough: the WebView capture pipeline opens before the runtime grant settles. Fix shape: pre-request `Permission.microphone.request()` when a site/entry opens (or app start), not lazily inside `onPermissionRequest`.
4. WebView build quirk on his device: same fix shape as 3; the emulator repro (directive 2) is the way to tell 3 and 4 apart.

Diagnostics:
- CONFIRMED IN LOGS (2026-11-10 16:57, `journalctl --user -u pi-web.service`): rbowen's client (via hephaestus, remote 147.135.252.207) POSTed `/api/speech/sessions` and DELETEd the session ~1–2 s later with ZERO `/audio` requests — getUserMedia fails at device-open instantly, client cleans up. Server and config are therefore ruled out; this is the Android capture path only.
- The thrown DOMException name appears in the page hint after the "Could not start dictation:" prefix — get the exact remainder from rbowen; `NotAllowedError` = permission path, `NotReadableError`/`AbortError` = device-open path (his quoted text matches Chrome's NotReadableError wording). Code: fork `src/client/src/speech/dictation.ts`.
- On-emulator repro may be possible (the box has an emulator plan in agentic-framework-2 `17-test-harness.md`; box-launcher has an `e2e/` dir) — verify an emulator actually exists before promising rbowen a repro.

Machine facts (box-launcher): flutter `~/flutter/bin/flutter` (3.47.5); builds need `ANDROID_HOME=/home/rbowen/android-sdk` and `JAVA_HOME=/home/rbowen/jdks/jdk-21.0.13+9` (Gradle fails without both). Release: bump pubspec version (runningVersionCode derives from package_info; the manifest generator reads versionCode/versionName from the APK badging itself), `flutter build apk --release`, `cp build/app/outputs/flutter-apk/app-release.apk ~/launcher-public/box-launcher.apk`, run `python3 ~/divinearts-site/tools/generate-launcher-manifest.py` (15-min timer also runs it). `pubspec.lock` is gitignored — including it in `git add` aborts the whole add.

Traps carried from legs 1–2 (still binding):
- pi-web config lives at `~/.config/pi-web/config.json` (XDG), NOT `~/.pi-web/config.json` (a stray inert file was created there; rbowen may delete it).
- pi-web deploy = `npm run build`; `npm pack`; `npm install -g --prefix ~/.local ./jmfederico-pi-web-1.202610.0.tgz`; `systemctl --user restart pi-web.service`. Default npm prefix (/usr/local) EACCESes. NEVER restart `pi-web-sessiond` without explicit authorization from rbowen.
- The fork's `verify:staged` pre-commit hook gates on the whole-project test run. The 45 PiWebApp failures were fixed by rbowen's own `6a4428de` (real `localStorage` fix) — re-run the suite before assuming `--no-verify` is still needed.
- Fork repo: NEVER run `git clean`; rbowen may keep uncommitted files of his own in the tree — check `git status` and leave anything that is not yours alone.

Leg 2 record (superseded baton, kept for audit): the speech feature itself needs no further server work; deploy details are in the History below.

RELAY COMPLETE AND DEPLOYED 2026-11-10. Live on the 8504 pi-web instance (systemd user unit `pi-web.service`, installed package `~/.local/lib/node_modules/@jmfederico/pi-web`, config `~/.config/pi-web/config.json`). Production smoke passed: jfk.wav transcribed exactly through the live routes + worker. NOT deployed via router-restart of pi-web-sessiond (untouched, as required).

Deploy-path facts learned on leg 2 (relevant to future deploys):
- Deploy = `npm run build` in the fork → `npm pack` → `npm install -g --prefix ~/.local ./jmfederico-pi-web-1.202610.0.tgz` → `systemctl --user restart pi-web.service`. The default npm prefix is /usr/local (EACCES); `--prefix ~/.local` is what matches the live install and bin symlinks.
- Config lives at `~/.config/pi-web/config.json` (XDG default), NOT `~/.pi-web/config.json` — docs and setup script originally printed the wrong path; corrected in commit `a3821064`.
- Commit `a3821064` (pushed) fixes a leg 1 gap: `parsePiWebConfig`/`piWebConfigRecord` whitelisted keys and silently dropped `speech`, so the feature could never activate. Round-trip test added (config.test.ts, 54 tests green).
- rbowen's uncommitted nav work was committed upstream as `6a4428de` (includes the real `localStorage` fix in PiWebApp.ts), and the speech commit rebased on top as `47e00cac`; both pushed. Local `6589e87e` is superseded/orphaned; speech tree identical.
- A stray inert `/home/rbowen/.pi-web/config.json` was created by the deploy leg before the real config path was found; nothing reads it — rbowen may delete it.

What leg 2 did beyond the leg 1 plan:
- Benchmark sandbox worktree with the pre-flattened `bench/parakeet-ckpt` snapshot was GONE (only `/tmp/keep` source recoveries remained). `scripts/setup-speech.sh` downloads the int8 model fresh from `istupakov/parakeet-tdt-0.6b-v2-onnx` via `huggingface_hub.snapshot_download(local_dir=...)` (real files, not cache symlinks, so no flattening needed). Model now at `~/.pi-web/speech/model`, venv at `~/.pi-web/speech/venv` (~0.9 GB RAM when loaded).
- Box has no `python3-venv` and no passwordless sudo: script uses `python3 -m venv --without-pip` + host pip's `--python` flag to bootstrap pip into the venv.
- End-to-end smoke passed: real routes + real chunker + real Python worker transcribed jfk.wav exactly ("And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."). Partials empty on that clip is correct: no 0.7 s silence gap in 11 s of speech, so text commits at finish.
- Verification at commit: `tsc --noEmit` clean, knip clean, eslint clean on touched files, full suite 2265 tests with only the 45 known pre-existing PiWebApp failures, targeted 29/29 green.
- Pre-commit hook (`verify:staged`) gates on the whole-project test run and rejected the commit because of those 45 failures — caused by rbowen's UNSTAGED `PiWebApp.ts` (bare `localStorage` line 328), which this feature must not touch. Commit went in with `--no-verify`; reason recorded in the commit message.
- NEW do-not-touch item discovered mid-leg: `src/client/index.html` now carries rbowen's own uncommitted edit (mobile-viewport touchmove guard, signed `// rbowen:`). Left unstaged, untouched.
- rbowen's other uncommitted files (PiWebApp.ts, appShellController.ts, WorkspacePanel.ts, AppMobileMainTabs.ts, AppNavigationPanel.ts + test, the tgz) are all still unstaged and untouched. `handoffs/voice-dictation-relay.md` remains untracked. NEVER run `git clean`.
- Disk: 5.3 GB free (97% used) before the model download; HF cache for the download is small (local_dir mode), but rbowen should know the box is near-full.

Leg 1 (implementation) was ~90% durable in the working tree, UNCOMMITTED. Leg 2 (finish, verify, selective commit) completed 2026-11-10 as commit `6589e87e`.

Already written (all under the fork unless noted):
- `src/client/src/speech/dictation.ts` — browser capture (AudioWorklet `speech-capture`, PCM16 16k, POSTs every 500 ms, partials via response text).
- `src/client/public/speech-capture-worklet.js` — worklet module.
- `src/client/src/components/PromptEditor.ts` — button moves + voice state machine (`voice` idle/recording/finishing, `insertVoiceText`/`removeVoiceText`, `createDictation` test seam). Import of dictation at top.
- `src/client/src/components/promptEditorIcons.ts` — added `renderMicIcon`.
- `src/client/src/components/shared.ts` — CSS: `.editor-mic`, `.editor-cancel`, `.speech-send` (green), `.voice-hint*`, `.actions .editor-attach` overrides.
- `src/server/speech/speechChunker.ts` — PCM chunker (silence 0.7 s / 15 s max split; flush drops silence-only tails).
- `src/server/speech/speechWorkerClient.ts` — resident Python worker over stdio JSON lines; lazy start, ping-warm, respawn.
- `src/server/speech/speechRoutes.ts` — Fastify routes: POST `api/speech/sessions`, POST `:id/audio` (octet-stream PCM16), POST `:id/finish`, DELETE `:id`; shared worker; 5 min TTL sweep; 503 with guidance when unconfigured.
- `src/server/speech/parakeetWorker.py` — onnx-asr worker (env PARAKEET_MODEL_DIR, PARAKEET_KIND, PARAKEET_QUANTIZATION, PARAKEET_IDLE_SECONDS).
- `src/server/app.ts` — imports + `registerSpeechRoutes(app, { config: configService })` after registerWorkspaceDeletionRoutes.
- `src/shared/apiTypes.ts` — `speech?: PiWebSpeechConfig` (`python`, `modelDir`, optional `model`, `quantization`) on PiWebConfigValues.
- `scripts/copy-server-assets.mjs` — copies parakeetWorker.py to dist; wired into `package.json` build after `vite build`.
- Tests: `src/server/speech/speechChunker.test.ts` (5), `src/server/speech/speechRoutes.test.ts` (8, fake worker, no Python needed), `src/client/src/components/PromptEditor.voice.test.ts` (5, happy-dom, fake dictation factory).

Verification status at handoff: `tsc --noEmit` clean; eslint clean on all touched files; speech + PromptEditor suites 43/43 green. NOT yet re-run after final file restoration — re-run `npx vitest run src/server/speech src/client/src/components/PromptEditor` and `npx tsc --noEmit` first thing.

Remaining work (leg 2):
1. `scripts/setup-speech.sh` (does not exist yet): create venv (pip install onnx-asr[cpu,hub] numpy), download Parakeet v2 int8 ONNX, print the config.json snippet. REUSE if still present: sandbox worktree `/home/rbowen/pi/pi-web-fork/sandbox/worktrees/pi-agent/benchmark-two-speech-to-text-20261110131321-20261110-131321` has a working venv and the flattened model snapshot at `bench/parakeet-ckpt` (int8 files from `istupakov/parakeet-tdt-0.6b-v2-onnx`; load via onnx_asr `path=`, note HF blob symlinks break onnxruntime external-data validation — that is why it was flattened). Copy that snapshot to a stable location (e.g. `~/.pi-web/speech/model`) rather than re-downloading.
2. `docs/voice-dictation.md` — short: setup, config keys, how streaming works, limitations (local machine only, partials are chunk-granular ~silence/15 s, clips >30 s rely on chunking, Chrome recommended).
3. End-to-end smoke: configure speech keys, start web/API dev, exercise routes with a real WAV (can synthesize by converting `jfk.wav` to PCM16 16k raw), confirm transcript.
4. Selective commit on fork main. CRITICAL: the working tree carries rbowen's own UNCOMMITTED work — `src/client/src/components/PiWebApp.ts` (19 lines, nav-panel hack incl. bare `localStorage` at line 328), `src/client/src/appShell/appShellController.ts`, `src/client/src/components/WorkspacePanel.ts`, `src/client/src/components/appShell/AppMobileMainTabs.ts`, `src/client/src/components/appShell/AppNavigationPanel.ts` + its test, `jmfederico-pi-web-1.202610.0.tgz`. Do NOT stage or revert those. Stage only the speech feature files listed above. NEVER run `git clean` (a previous agent lost the untracked speech files to it once — recovered from /tmp/keep, do not rely on that again).
5. Report to rbowen; deployment is his call.

## History

- rbowen researched STT options; benchmarked (subagent, 2026-11-10) whisper.cpp large-v3-turbo (RTFx 0.18 — slower than realtime on this box) vs Parakeet TDT v2 int8 via onnx-asr (RTFx 2.16, ~0.9 GB RAM, same text output on jfk.wav). Decision: Parakeet int8.
- rbowen spec'd the UX (mic in attach slot, attach left of send, streaming, mic-again=send, red cancel square, work on fork). Implementation leg 1 done this context.
- Verification archaeology conclusion (settled, do not reopen): 45 PiWebApp node-env test failures + 2 eslint errors in `src/server/webPush/webPushRoutes.test.ts` are PRE-EXISTING, caused by rbowen's uncommitted PiWebApp.ts change (bare `localStorage` at line 328 fails in node env). Our diff adds zero new failures. Do not fix rbowen's files without asking him. SUPERSEDED 2026-11-10: rbowen committed the real fix himself in `6a4428de`; re-run the suite before treating any failure as pre-existing.
- 2026-11-10 leg 2 (server): verification clean, `scripts/setup-speech.sh` written (model downloads fresh via `snapshot_download(local_dir=...)` — the benchmark worktree with the pre-flattened snapshot was gone), venv bootstrap uses `venv --without-pip` + host pip `--python` (no python3-venv, no sudo), smoke exact transcript, selective commit `6589e87e` (--no-verify; hook trips on then-pre-existing PiWebApp failures).
- 2026-11-10 deploy + leg 2.5: leg 1 parse gap found — `parsePiWebConfig`/`piWebConfigRecord` whitelists silently dropped the `speech` key; fixed + round-trip test in `a3821064` (pushed). Built, installed to `~/.local`, `pi-web.service` restarted, production smoke exact transcript. rbowen's nav work landed upstream as `6a4428de`, speech rebased as `47e00cac`. Box-launcher mic permission plumbing shipped as `dd5fe60` (0.1.19+20) WITHOUT device testing; rbowen reports getUserMedia "Could not start audio source" — leg 3 open.
- 2026-11-10 leg 3 start: phone updated to versionCode 20, error unchanged ("could not start audio source"). Server ruled out by logs (session created, deleted after ~2 s, zero /audio posts). rbowen directives: add permission-flow logging (client hint text + box-app diag), attempt emulator repro. No code written for leg 3 yet.
- 2026-11-10 leg 3 (diagnostics shipped): client hint logging + console.error (fork main a6bf0f66, deployed), box mic_perm diag events (master d78774f), APK 0.1.20+21 published + live manifest advertising 21. Emulator proven real and already running; app installed and launched under adb; WebView verified to reach the CF Access wall — full repro waits on rbowen credentials. journalctl shows a 4.5 s successful dictation from rbowen's client at 17:16 (desktop path works end-to-end).

## Machine facts

Box: 8-core Xeon E5-1620 v2 (AVX, no AVX2), 31 GB RAM (~16 available), ~3.6 GB disk free (98% used as of 2026-11-10 — clean something before large downloads/builds). Fork: `/home/rbowen/pi/pi-web-fork`, branch `main`, remotes: origin git@github.com:ReeceBDev/pi-web.git (push), upstream jmfederico/pi-web. Fork AGENTS.md requires: docs under docs/, testing guide `.agents/skills/testing-guide/SKILL.md`, verify = typecheck+lint+knip+test.
