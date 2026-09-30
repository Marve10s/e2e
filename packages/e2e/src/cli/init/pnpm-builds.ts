/**
 * The `e2e init` step for pnpm projects. pnpm 11 and later fail an install
 * whose dependencies have a build script the project has not decided on
 * (`ERR_PNPM_IGNORED_BUILDS`), and `e2e` loads TypeScript with tsx, which
 * depends on esbuild. esbuild's postinstall only hard-links its CLI binary
 * over the JavaScript shim and prints the binary's version; the JavaScript
 * API tsx calls finds the binary in esbuild's platform package at run time.
 * So init records the build as skipped under `allowBuilds`, which pnpm reads
 * from `pnpm-workspace.yaml` and nowhere else.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const ENTRY = 'esbuild: false';
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
 * is not a block mapping.
 */
export function planPnpmBuilds(cwd: string): PnpmBuildsPlan | undefined {
  const found = findWorkspaceFile(cwd);
  if (found === undefined) return { kind: 'write', relative: WORKSPACE_FILE, existing: false, content: `${BLOCK.join('\n')}\n` };
  const original = readFileSync(found, 'utf8');
  const relative = path.relative(cwd, found).split(path.sep).join('/');
  const content = withEsbuildDecided(original);
  if (content === original) return undefined;
  if (content === undefined || path.dirname(found) !== path.resolve(cwd)) return { kind: 'manual', relative };
  return { kind: 'write', relative, existing: true, content };
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
  if (lines.some((line) => /^dangerouslyAllowAllBuilds\s*:\s*true\b/.test(line))) return text;
  const header = lines.findIndex((line) => /^allowBuilds\s*:/.test(line));
  if (header === -1) {
    const separator = body.trim() === '' ? '' : body.endsWith('\n') ? newline : `${newline}${newline}`;
    return `${bom}${body.trim() === '' ? '' : body}${separator}${BLOCK.join(newline)}${newline}`;
  }
  const inline = lines[header]!.replace(/^allowBuilds\s*:/, '').replace(/#.*$/, '').trim();
  if (inline !== '') return /(?:^|[{,\s])(['"]?)esbuild\1\s*:\s*(?:true|false)\s*(?:[,}]|$)/.test(inline) ? text : undefined;
  // The block runs until the next top-level key; blank lines and comments at any indentation stay inside it.
  let end = header + 1;
  while (end < lines.length && /^(?:\s|#|$)/.test(lines[end]!)) end += 1;
  const entry = lines.findIndex((line, index) => index > header && index < end && /^\s+(['"]?)esbuild\1\s*:/.test(line));
  const edited = [...lines];
  if (entry === -1) {
    const indent = lines.slice(header + 1, end).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))?.match(/^\s+/)?.[0] ?? '  ';
    edited.splice(header + 1, 0, `${indent}${ENTRY}`);
  } else if (/:\s*(?:true|false)\s*(?:#.*)?$/.test(lines[entry]!)) {
    return text;
  } else {
    edited[entry] = lines[entry]!.replace(/:.*$/, ': false');
  }
  return `${bom}${edited.join(newline)}`;
}
