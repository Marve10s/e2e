---
"e2e": patch
---

A TypeScript import of a directory through a package subpath or a `#` import now loads the directory's `main` or `index.ts`, the way TypeScript resolves it. A workspace package without `exports` imported as `@acme/db/enums`, an `exports` entry naming a directory, and a `#` import mapped to one used to fail collection with `ERR_UNSUPPORTED_DIR_IMPORT`. A relative directory import already worked. Under Yarn PnP, a package subpath that names a directory still fails: PnP's resolver does not say which directory it found.
