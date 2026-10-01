---
"e2e": patch
---

A registered secret value passed as a plain string is now redacted in more places: test and describe titles (and the test ids, reporter output, and artifact and failure-page file names derived from them), step labels, `agent.act` and `agent.assert` instructions and params as executors and the model receive them, `agentContext`, judgment prompts, and an `e2e explore` goal. Before, only error messages and observations masked it. A test whose title spells out a secret gets a new id, so `--last-failed` from an earlier run does not select it once. Not covered: a value only a secret provider returns stays in titles, and a Playwright trace of a session no secret reached is kept as recorded.
