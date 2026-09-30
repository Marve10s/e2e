---
'e2e': patch
---

A failure where no model answered (`MODEL_PROVIDER_FAILED`, `MODEL_UNAVAILABLE`) no longer evicts replay cache entries. It says nothing about the app, so a read-write run without model access keeps every recording it did not confirm, including a step that replayed whole before an `agent.assert` that could not reach its model and a replay that handed off to the model mid-step, and still saves the steps verified before the failure.
