---
'e2e': patch
---

`e2e init` on pnpm adds `esbuild: false` under `allowBuilds` in `pnpm-workspace.yaml`, creating the file when missing, so `pnpm install` on pnpm 11 and later no longer fails with `ERR_PNPM_IGNORED_BUILDS: esbuild`. tsx, which `e2e` loads TypeScript with, calls esbuild's JavaScript API, which finds its binary without the build script. An existing `esbuild` entry is kept; a workspace root above the project, or an inline `allowBuilds`, gets a warning naming the line to add instead of an edit.
