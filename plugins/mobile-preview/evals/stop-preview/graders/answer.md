---
type: llm
---
PASS if the response gives `mp.cmd stop --port 3000` (or `mp stop --port 3000` while noting PowerShell needs `mp.cmd` because `mp` is an alias for Move-ItemProperty).
FAIL if it tells the user to kill cloudflared/node processes manually, gives a generic answer, or recommends plain `mp` in PowerShell without the `.cmd` caveat.
