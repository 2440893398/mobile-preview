---
type: llm
---
PASS if the response gives a way to reach the app from the phone through a public tunnel/preview (ideally `mp.cmd start --port 5173 --dev`, or an equivalent authenticated tunnel), and explains that http://localhost:5173 or 127.0.0.1 cannot be opened on the phone. Extra credit for noting WebSocket/HMR does not work through the preview (reload manually) and that the link is a credential.
FAIL if the response hands the user a localhost / 127.0.0.1 / LAN-less URL as the thing to open on the phone, or gives no workable way to reach the app remotely.
