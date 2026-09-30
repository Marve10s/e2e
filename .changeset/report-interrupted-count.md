---
'e2e': minor
'@e2e-dev/github': patch
---

Breaking: an interrupted test is no longer counted as failed. `report.json` gains `run.summary.interrupted`, and `run.summary.failed` counts only failed and timed-out tests. `run.summary.skipped` now counts only selected tests, so `passed + failed + interrupted + flaky + skipped` equals `selected`; the tests a filter left out are `discovered - selected`. The `list` reporter prints `3 interrupted` in its own column, `summary.md` shows them with ⏹️ and gives them no failure block or page, and `junit.xml` writes each one as a `<skipped>` whose message starts `interrupted:`. The telemetry event gains `tests_interrupted`. In `@e2e-dev/github`, a test that was interrupted and then passed on a `--last-failed` rerun shows as passed, not flaky.
