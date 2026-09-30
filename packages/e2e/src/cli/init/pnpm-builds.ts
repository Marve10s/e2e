/**
 * The `e2e init` step for pnpm projects. pnpm 11 and later fail an install
 * whose dependencies have a build script the project has not decided on
 * (`ERR_PNPM_IGNORED_BUILDS`), and `e2e` loads TypeScript with tsx, which
 * depends on esbuild. esbuild's postinstall only hard-links its CLI binary
 * over the JavaScript shim and prints the binary's version; the JavaScript
 * API tsx calls finds the binary in esbuild's platform package at run time.
 * So init records the build as skipped under `allowBuilds`, which pnpm reads
 * from `pnpm-workspace.yaml` and nowhere else. pnpm 10 and older only warn
 * about the build, and pnpm 9 and early 10 refuse a `pnpm-workspace.yaml`
 * without `packages`, so init leaves them alone.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The first pnpm major that fails an install on an undecided build script. */
const STRICT_BUILDS_MAJOR = 11;

const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const ENTRY = 'esbuild: false';
/** The `allowBuilds` key at the top level, bare or quoted. */
const ALLOW_BUILDS = /^(['"]?)allowBuilds\1\s*:/;
const BLOCK = [
  "# e2e runs TypeScript through tsx, which calls esbuild's JavaScript API;",
  '# that finds the esbuild binary without the build script, so pnpm skips it.',
  'allowBuilds:',
  `  ${ENTRY}`,
];

type PnpmBuildsPlan =
  | { readonly kind: 'write'; readonly relative: string; readonly existing: boolean; readonly content: string }
  | { readonly kind: 'manual'; readonly relative: string };

/**
 * What init does so `pnpm install` accepts esbuild: nothing when the nearest
 * `pnpm-workspace.yaml` already decides it, a write when the project's own
 * file is missing or can take the entry, and a manual step when the entry
 * belongs in a workspace root above the project or in an `allowBuilds` that
 * is not a block mapping. Nothing for a pnpm known to be older than 11.
 * Throws with a message naming the file when it exists but cannot be read.
 */
export function planPnpmBuilds(
  cwd: string,
  packageManagerField: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PnpmBuildsPlan | undefined {
  const major = pnpmMajor(cwd, packageManagerField, env);
  if (major !== undefined && major < STRICT_BUILDS_MAJOR) return undefined;
  const found = findWorkspaceFile(cwd);
  if (found === undefined) return { kind: 'write', relative: WORKSPACE_FILE, existing: false, content: `${BLOCK.join('\n')}\n` };
  let original: string;
  try {
    original = readFileSync(found, 'utf8');
  } catch (cause) {
    throw new Error(`${found} could not be read (${cause instanceof Error ? cause.message : String(cause)}); fix it before running e2e init`, { cause });
  }
  const relative = path.relative(cwd, found).split(path.sep).join('/');
  const content = withEsbuildDecided(original);
  if (content === original) return undefined;
  if (content === undefined || path.dirname(found) !== path.resolve(cwd)) return { kind: 'manual', relative };
  return { kind: 'write', relative, existing: true, content };
}

/**
 * The major of the pnpm that will install: the `packageManager` pin, else
 * the pnpm running init (`pnpm dlx`), else `pnpm --version` on the PATH.
 * Undefined when none of them says.
 */
function pnpmMajor(cwd: string, packageManagerField: string | undefined, env: NodeJS.ProcessEnv): number | undefined {
  const pinned = packageManagerField?.match(/^pnpm@(\d+)\./)?.[1];
  if (pinned !== undefined) return Number(pinned);
  const invoking = env['npm_config_user_agent']?.match(/^pnpm\/(\d+)\./)?.[1];
  if (invoking !== undefined) return Number(invoking);
  const probe = spawnSync('pnpm', ['--version'], { cwd: existsSync(cwd) ? cwd : undefined, encoding: 'utf8', shell: process.platform === 'win32' });
  const reported = probe.status === 0 ? String(probe.stdout).trim().match(/^(\d+)\./)?.[1] : undefined;
  return reported === undefined ? undefined : Number(reported);
}

/** The nearest `pnpm-workspace.yaml` at or above `cwd`, the file pnpm reads its settings from. */
function findWorkspaceFile(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, WORKSPACE_FILE);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * `text` with esbuild's build decided: unchanged when `allowBuilds` sets
 * esbuild to true or false or every build is allowed. Otherwise the entry is
 * set to false (over the placeholder a failed pnpm install writes), added to
 * a block-style `allowBuilds`, or appended in a new block. Undefined for an
 * inline `allowBuilds` this line-based edit cannot extend. A byte order mark
 * is kept and never read as part of the first key.
 */
function withEsbuildDecided(text: string): string | undefined {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  if (lines.some((line) => /^(['"]?)dangerouslyAllowAllBuilds\1\s*:\s*(?:true|True|TRUE)\s*(?:#.*)?$/.test(line))) return text;
  const header = lines.findIndex((line) => ALLOW_BUILDS.test(line));
  if (header === -1) {
    const separator = body.trim() === '' ? '' : body.endsWith('\n') ? newline : `${newline}${newline}`;
    return `${bom}${body.trim() === '' ? '' : body}${separator}${BLOCK.join(newline)}${newline}`;
  }
  const inline = lines[header]!.replace(ALLOW_BUILDS, '').replace(/#.*$/, '').trim();
  if (inline !== '') return /(?:^|[{,\s])(['"]?)esbuild\1\s*:\s*(?:true|True|TRUE|false|False|FALSE)\s*(?:[,}]|$)/.test(inline) ? text : undefined;
  // The block runs until the next top-level key; blank lines and comments at any indentation stay inside it.
  let end = header + 1;
  while (end < lines.length && /^(?:\s|#|$)/.test(lines[end]!)) end += 1;
  const entry = lines.findIndex((line, index) => index > header && index < end && /^\s+(['"]?)esbuild\1\s*:/.test(line));
  const edited = [...lines];
  if (entry === -1) {
    const indent = lines.slice(header + 1, end).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))?.match(/^\s+/)?.[0] ?? '  ';
    edited.splice(header + 1, 0, `${indent}${ENTRY}`);
  } else if (/:\s*(?:true|True|TRUE|false|False|FALSE)\s*(?:#.*)?$/.test(lines[entry]!)) {
    return text;
  } else {
    edited[entry] = lines[entry]!.replace(/:.*$/, ': false');
  }
  return `${bom}${edited.join(newline)}`;
}
