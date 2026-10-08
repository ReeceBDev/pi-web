# Notification suppression for wake-parked and user-cancelled turns

Behaviour-driven design for the two completion-notification suppressions in
`PiSessionService`. Written before implementation; each scenario maps 1:1 to a
Vitest test added against `src/server/sessions/piSessionService.ts` in the
style of `piSessionService.pushGating.test.ts`.

## Background

A session turning idle records an **unread completion** in
`SessionUnreadStore` (via `observeUnreadActivityState`). That one record drives
both noises:

- the browser ding (client dispatches `pw-unread-ding` on the catalog event;
  the notify-sounds plugin plays it), and
- the Android push (`WebPushService`, additionally gated by
  `mayNotifyCompletion`).

So suppression happens at the recording choke point: a suppressed session is
treated as *still active for unread bookkeeping only*. Two independent
conditions set that flag, and both are **strictly per session** — never global.

| Condition | Set by | Cleared by |
|---|---|---|
| Wake-parked | a file in `~/.framework/wake/pending/` whose name ends `-{sessionId.slice(0,8)}.json` | the file's deletion (wake delivered, expired, or consumed) |
| User-cancelled | `PiSessionService.abort()` (the web UI Stop button / API abort) | the next `agent_start` in that session |

The spool directory must be injectable (option/dependency), so tests can point
it at a temp dir without touching `$HOME`.

## Feature 1 — Wake-parked turns stay silent

### Scenario: parked turn does not notify

- **Given** session S has a waiter file `repo-ab12cd34-S-PREFIX.json` in the
  spool `pending/` dir (S-PREFIX = first 8 chars of S's session id)
- **When** S's agent turn ends (register_wait returned, turn over)
- **Then** no unread completion is recorded for S: no catalog mutation with a
  new `completionOrder`, so no ding and no push.

### Scenario: the wake resolves and the real completion notifies

- **Given** session S is parked as above, turn already ended silently
- **When** the waiter file is deleted (wake delivered) and S's next turn
  finishes normally
- **Then** an unread completion IS recorded for S → ding + push as usual.

### Scenario: expiry notifies

- **Given** session S is parked, its waiter nears `expiry_minutes`
- **When** the extension's wall-cap timer deletes the waiter file and delivers
  the expiry notice, and that turn ends
- **Then** an unread completion IS recorded (the file is already gone) → the
  user hears the expiry ping.

### Scenario: suppression is per session

- **Given** sessions S1 and S2 are both running; only S1 has a waiter file
- **When** S1 and S2 both end turns
- **Then** S1 records no completion; S2 records one normally.

### Scenario: replies to a parked session stay silent until the wake resolves

- **Given** session S is parked
- **When** the user sends S a message and the reply turn ends (waiter file
  still present)
- **Then** no completion is recorded for that reply either. RESOLVED
  2026-10-08: these replies stay silent too. Simpler — no per-turn state to
  track — and the wake's own completion pings once the waiter is consumed.

### Scenario: stale waiter file cannot leak onto other sessions

- **Given** a waiter file for dead session id X lingers in the spool
- **When** a NEW session Y (different id, therefore different 8-char prefix)
  ends a turn
- **Then** Y records a completion normally.

## Feature 2 — User-cancelled turns stay silent

### Scenario: Stop button abort does not notify

- **Given** session S is streaming a response
- **When** the user presses Stop (server `abort(ref)` runs, run unwinds,
  `agent_end` fires)
- **Then** no unread completion is recorded for S: the aborted partial output
  never dings or pushes.

### Scenario: the session recovers after a cancel

- **Given** session S was cancelled as above (quiet flag set)
- **When** the user prompts S again and the new turn finishes normally
- **Then** the quiet flag cleared on `agent_start`, and an unread completion
  IS recorded for the new turn → ding + push as usual.

### Scenario: cancel is per session

- **Given** sessions S1 and S2 are both streaming
- **When** the user cancels only S1
- **Then** S1 records no completion; S2 records one when its own turn ends.

### Scenario: failures are not silent

- **Given** session S's turn ends in an error state (not a user abort)
- **When** the turn ends
- **Then** a completion IS recorded — only user-initiated `abort()` sets the
  quiet flag.

### Out of scope

- Abort inside a TUI `pi` process: different process, never reaches this
  server path. Documented, untested here.
- Session close/stop (`stop()` → `closeActive`): already silent via the
  existing `forgetUnreadActivity` path; no new behavior, no new test beyond an
  existing-coverage check if one is absent.

## Test layer and mechanics

Per the repo testing guide: smallest layer that proves the behavior —
`PiSessionService` service tests with the existing fakes
(`fakeRuntime`, `sessionGateway`, `CapturingSessionEventHub`), plus a real
temp dir as the injectable spool. No browser, no push mock: the catalog
mutation (or its absence) is the observable outcome, and both downstream
noises are already proven consumers of that catalog.

Planned spec file: `src/server/sessions/piSessionService.notifySuppression.test.ts`
with one `it` per scenario above. Implemented 2026-10-08; the doc's scenario
count is ten (six wake-parked, four user-cancelled), all covered.

Implementation notes as built (deltas from the pre-implementation sketch):

- The choke point passes `hasActiveWork(session) || isNotificationSuppressed(session)`
  into `SessionUnreadStore.observeActivityState`; nothing else changes. Status
  display (`"working"`) and `hasActiveWork()` never consult the suppressions.
- The spool scan is a sync `readdir` of `<spoolDir>/pending/` behind a
  per-session TTL cache (`WAKE_SPOOL_CACHE_TTL_MS`, 5s, clock = the existing
  `now` dependency). Cache is keyed per session, so one session's answer never
  masks another's. A missing `pending/` dir is the normal not-parked case and
  is not logged; any other read error is logged and treated as unparked.
- The user-cancelled quiet flag is a `Map` keyed by session id, set in
  `abort()` before `abortSessionOperations` runs, deleted in the
  `agent_start` branch of `publishActivityForEvent`.
- Because of the TTL cache, a waiter file's deletion is noticed on the next
  scan after at most ~5s; the wake-resolve and expiry scenarios advance the
  injected test clock past the TTL before the turn ends. In production the
  wake's completion typically lands more than one heartbeat after the file is
  consumed, so the delay is not observable there.

Test-session ids must differ within their first 8 characters: the waiter
matcher is the `-{first 8 chars}.json` suffix, so two test ids sharing a
prefix (`session-1` / `session-2`) would park each other. The per-session
scenarios use distinct prefixes.

Manual acceptance on the live box after deploy (once, not automated):
register a wait in a scratch session and confirm no ping; press Stop mid-run
and confirm no ping; let a wake land and confirm the real completion pings.
