---
"e2e": patch
---

Locator matchers honor Playwright's options instead of ignoring them: `toBeVisible({ visible: false })`, `toBeAttached({ attached: false })`, `toBeEnabled({ enabled: false })`, and `toBeChecked({ checked: false })` wait for the opposite state, and `ignoreCase` works on `toHaveText`, `toContainText`, `toHaveAccessibleName`, and `toHaveAttribute(name, value)`. An option a matcher does not take, such as `useInnerText` or a misspelled `timeout`, now throws `INVALID_ARGUMENT` before polling. `locator.waitFor` adds the `attached` and `detached` states and rejects an unknown state or option key, which used to pass as `hidden`. `toHaveProperty` reaches into a string on the path, so `toHaveProperty('label.length', 3)` passes as in Jest.
