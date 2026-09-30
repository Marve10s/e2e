---
'e2e': patch
---

`e2e init` on pnpm 11 and later adds `esbuild: false` under `allowBuilds` in `pnpm-workspace.yaml`, creating the file when missing, so `pnpm install` on pnpm 11 and later no longer fails with `ERR_PNPM_IGNORED_BUILDS: esbuild`. tsx, which `e2e` loads TypeScript with, calls esbuild's JavaScript API, which finds its binary without the build script. An `esbuild: true` or `false` you already have is kept, and the placeholder a failed `pnpm install` leaves there is set to `false`. A workspace root above the project, or an inline `allowBuilds`, gets a warning naming the entry to add instead of an edit. pnpm 10 and older, which only warn about the build, are left alone.
