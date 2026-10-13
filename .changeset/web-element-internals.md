---
"@e2e-dev/web": patch
---

Read custom-element roles and accessible names from ElementInternals defaults, respecting ariaHidden exclusion. Role queries keep finding elements after hydration, and explicit attributes override the defaults without changing the page's DOM.
