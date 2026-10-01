/** Text normalization and matching rules. */

import { types } from 'node:util';
import type { TextPattern } from '../engine/contract.ts';
import type { TextMatch } from '../types.ts';
import { sanitizeText, TestError } from './errors.ts';
import { testPattern } from './regexp.ts';

export type { TextPattern };

/**
 * Normalizes text by trimming leading/trailing whitespace and replacing every
 * nonempty run of Unicode whitespace with one ASCII space.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Normalizes text that may carry control characters: sanitized first, then
 * whitespace-collapsed. The one-line form of screen text that reaches models,
 * trace descriptors, and terminals.
 */
export function collapseText(text: string): string {
  return normalizeText(sanitizeText(text));
}

/** Whether `value` is a `TextMatch`: a string, or a RegExp from any realm. */
export function isTextMatch(value: unknown): value is TextMatch {
  return typeof value === 'string' || types.isRegExp(value);
}

/**
 * Converts a public TextMatch plus options into the wire TextPattern form.
 * Anything but a string or a RegExp (from any realm), such as a
 * Playwright-style predicate, is `INVALID_ARGUMENT`: read as a regexp it would
 * have no source and match everything.
 */
export function toTextPattern(match: TextMatch, options?: { exact?: boolean }): TextPattern {
  if (typeof match === 'string') {
    return { kind: 'string', value: match, exact: options?.exact ?? true };
  }
  if (!types.isRegExp(match)) {
    throw new TestError('INVALID_ARGUMENT', `pattern must be a string or RegExp, got ${typeof match}`);
  }
  return { kind: 'regexp', source: match.source, flags: normalizeRegexpFlags(match.flags) };
}

/** Sorts and de-duplicates regexp flags into canonical d,g,i,m,s,u,v,y order. */
export function normalizeRegexpFlags(flags: string): string {
  const order = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];
  const present = new Set(flags.split(''));
  return order.filter((flag) => present.has(flag)).join('');
}

/** How a text matcher reads the two strings it compares. */
export interface TextComparison {
  /** `contains` accepts the expected string anywhere in the actual one; a regexp is tested the same way in both modes. */
  readonly mode: 'equals' | 'contains';
  /** Whether both sides are whitespace-normalized first. `false` compares the raw strings, as a form control's value is. */
  readonly normalize: boolean;
  /**
   * Playwright's `ignoreCase`: `true` folds case on both sides of a string
   * comparison and adds the `i` flag to a regexp, `false` removes it from a
   * regexp; absent leaves the pattern as written.
   */
  readonly ignoreCase?: boolean;
}

/**
 * Matches normalized text against a pattern. String matching is exact by
 * default; `exact: false` is case-insensitive substring matching. Regular
 * expressions use ECMAScript semantics with lastIndex reset before every match.
 */
export function matchesText(actual: string, pattern: TextPattern): boolean {
  return compareText(actual, pattern, { mode: 'equals', normalize: true });
}

/**
 * The one text-matching rule. `mode` applies only to exact string patterns:
 * regexps and case-insensitive substrings read the same way in both.
 * `normalize: false` leaves whitespace alone on both sides, for a field the
 * platform reports verbatim.
 */
export function compareText(actual: string, pattern: TextPattern, comparison: TextComparison): boolean {
  const normalized = comparison.normalize ? normalizeText(actual) : actual;
  if (pattern.kind === 'regexp') {
    return testPattern(pattern.source, casedFlags(pattern.flags, comparison.ignoreCase), normalized);
  }
  const value = comparison.normalize ? normalizeText(pattern.value) : pattern.value;
  if (!pattern.exact) return normalized.toLowerCase().includes(value.toLowerCase());
  const fold = comparison.ignoreCase === true;
  const subject = fold ? normalized.toLowerCase() : normalized;
  const expected = fold ? value.toLowerCase() : value;
  return comparison.mode === 'equals' ? subject === expected : subject.includes(expected);
}

/**
 * The regexp `ignoreCase` makes of `pattern`, as Playwright's matchers do:
 * `true` adds the `i` flag, `false` removes it. A string pattern, or an
 * absent `ignoreCase`, comes back as is.
 */
export function withIgnoreCase(pattern: TextPattern, ignoreCase: boolean | undefined): TextPattern {
  if (pattern.kind !== 'regexp') return pattern;
  return { ...pattern, flags: casedFlags(pattern.flags, ignoreCase) };
}

/** Regexp flags with the `i` flag added for `ignoreCase: true`, removed for `false`, and left alone when absent. */
function casedFlags(flags: string, ignoreCase: boolean | undefined): string {
  if (ignoreCase === undefined) return flags;
  const rest = flags.replace('i', '');
  return normalizeRegexpFlags(ignoreCase ? `${rest}i` : rest);
}

/** Renders a pattern for diagnostics. */
export function describePattern(pattern: TextPattern): string {
  if (pattern.kind === 'string') return JSON.stringify(pattern.value);
  return `/${pattern.source}/${pattern.flags}`;
}
