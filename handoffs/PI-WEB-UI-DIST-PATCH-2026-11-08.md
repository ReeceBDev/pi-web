# pi-web-ui dist patch — findSessionOwner streaming preference (2026-11-08)

File: `~/.local/lib/node_modules/pi-web-ui/dist/server/agent-service.js`,
function `findSessionOwner` (was line ~6551).

**Bug (observed 2026-11-07 23:58 UTC):** the function returned the FIRST
client holding a session file. An idle zombie client session (left by an
app cold-start) sorted before the streaming writer, so the attach guard
saw `isStreaming: false`, allowed `continueRecent()` to open the same
session file as a SECOND writer with a stale leaf — the next user prompt
parented to the stale node and forked the session tree, orphaning the
assistant reply that had just completed. Reply invisible in UI, snapshots,
and agent context.

**Patch:** scan ALL holders; return the streaming one immediately; keep the
first idle holder as fallback. Proof-of-bug backup of the corrupted
session: `…/sessions/--home-rbowen-pi--/2026-11-07T23-45-27-664Z_01a1b867….jsonl.bak-parentfix-20261108`.

**THIS PATCH LIVES IN DIST ONLY — it is lost on every pi-web-ui package
update.** After updating pi-web-ui: re-apply (same function, same change)
or land it upstream (package author: xingshuyin). The repaired session is
`01a1b867-…` in `~/.pi/agent/sessions/--home-rbowen-pi--/`.
