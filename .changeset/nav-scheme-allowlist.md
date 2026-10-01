---
"e2e": patch
"@e2e-dev/mobile": patch
---

`app.open`, `browser.goto`, and the agent's `navigate` verb admit `http:` and `https:` URLs only. A wrapped scheme such as `view-source:file:///...` no longer loads a local file; it is `POLICY_DENIED` like `file:` itself. `device.openLink` and `device.openApp` also refuse `view-source:`, `blob:`, and `filesystem:` links.
