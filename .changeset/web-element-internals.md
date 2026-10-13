---
"@e2e-dev/web": patch
---

Read custom-element roles, accessible names, and reported ARIA states from ElementInternals defaults. Role queries keep finding elements after hydration, and explicit attributes override the defaults without changing the page's DOM.
