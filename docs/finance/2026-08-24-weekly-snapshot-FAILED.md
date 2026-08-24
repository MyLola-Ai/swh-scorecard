# weekly revenue snapshot FAILED — 2026-08-24
Generated 2026-08-24T14:15:35Z

```
file:///Users/austen/swh-scoreboard/scripts/cfo-revenue-snapshot.mjs:27
  throw new Error(`token exchange failed: HTTP ${tokRes.status} — ${body}`);
        ^

Error: token exchange failed: HTTP 400 — {
  "error": "invalid_grant",
  "error_description": "reauth related error (invalid_rapt)",
  "error_uri": "https://support.google.com/a/answer/9368756",
  "error_subtype": "invalid_rapt"
}
    at file:///Users/austen/swh-scoreboard/scripts/cfo-revenue-snapshot.mjs:27:9
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)

Node.js v24.14.1
```
