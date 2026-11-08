# FINDINGS — GET /sessions?cwd request flood (pi-web front / sessiond)

- Symptom: 671 requests in 9 minutes to `GET /sessions?cwd=…`, some taking 3 s, jamming pi-web-sessiond and delaying the + New Work session-create chain by ~75 s in E2E runs on 2026-11-07/08.
- Status: NOT root-caused, NOT fixed. Went dormant on its own after the pi-web.service front restart at 2026-11-08 17:31:11 UTC — zero `GET /sessions?cwd` requests in the 10-minute window checked at 22:30 UTC.
- How to re-detect: `journalctl --user -u pi-web --since '-10 min' --no-pager | grep -c 'GET /sessions?cwd'` (same for `-u pi-web-sessiond`).
- Working suspicion (unverified): a stuck per-tab polling loop in the then-running client — the flood vanished exactly when the front process restarted and browser tabs reconnected, which fits a client-side loop rather than a server-side scheduler.
- Blast radius today: much smaller even if it returns — commit 547871db (parallel worktree scan, one origin read per unit) took the catalog p90 from 3.1 s to 23 ms, and commit 4a531683 stops the client from blocking session start on the catalog at all.
