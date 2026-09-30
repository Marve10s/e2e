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
 * `text` with esbuild's build decided: unchanged when `allowBuilds` names
 * esbuild or every build is allowed, the entry added to a block-style
 * `allowBuilds` or a new block appended when there is none, and undefined
 * for an inline `allowBuilds` this line-based edit cannot extend.
 */
function withEsbuildDecided(text: string): string | undefined {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => /^dangerouslyAllowAllBuilds\s*:\s*true\b/.test(line))) return text;
  const header = lines.findIndex((line) => /^allowBuilds\s*:/.test(line));
  if (header === -1) {
    const separator = text.trim() === '' ? '' : text.endsWith('\n') ? newline : `${newline}${newline}`;
    return `${text.trim() === '' ? '' : text}${separator}${BLOCK.join(newline)}${newline}`;
  }
  const inline = lines[header]!.replace(/^allowBuilds\s*:/, '').replace(/#.*$/, '').trim();
  if (inline !== '') return /\besbuild\b/.test(inline) ? text : undefined;
  const block: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    block.push(line);
  }
  if (block.some((line) => /^\s+['"]?esbuild['"]?\s*:/.test(line))) return text;
  const indent = block.find((line) => line.trim() !== '' && !line.trim().startsWith('#'))?.match(/^\s+/)?.[0] ?? '  ';
  return [...lines.slice(0, header + 1), `${indent}${ENTRY}`, ...lines.slice(header + 1)].join(newline);
}
