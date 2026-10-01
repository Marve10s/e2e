---
"e2e": patch
---

A registered secret value passed as a plain string is redacted everywhere: test and describe titles (and the test ids, reporter output, and artifact and failure-page file names derived from them), step labels, `agent.act` and `agent.assert` instructions and params as executors and the model receive them, `agentContext`, and judgment prompts. Before, only error messages and observations masked it.
