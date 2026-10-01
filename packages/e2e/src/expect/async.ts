/** Runner-owned polling locator assertions. */

import type { SemanticNode } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import {
  isTextMatch,
  normalizeText,
  compareText,
  toTextPattern,
  describePattern,
  withIgnoreCase,
  type TextComparison,
  type TextPattern,
} from '../internal/text.ts';
import { isValueControl } from '../internal/roles.ts';
import { Deadline, pollCondition } from '../internal/time.ts';
import { attributeOf, denySecureRead, isNodeVisible } from '../locator/engine.ts';
import { describeExpression } from '../locator/expression.ts';
import type { LocatorInternals } from '../locator/screen.ts';
import type { AsyncExpectation, TextMatch, TextMatcherOptions } from '../types.ts';

interface Sample {
  readonly count: number;
  readonly node: SemanticNode | null;
  /** Every current match, read; only a `wholeSet: 'read'` matcher asks for them. */
  readonly nodes: readonly SemanticNode[];
}

interface MatcherSpec {
  readonly name: string;
  /**
   * Evaluates the whole sample instead of requiring one node: `true` counts
   * the matches, `'read'` also reads each of them.
   */
  readonly wholeSet?: boolean | 'read';
  /** The predicate is meaningful even when zero nodes match. */
  readonly evaluableWithoutNode?: boolean;
  /**
   * Whether the one matched node can answer the predicate at all. A node it
   * rejects keeps the poll waiting, negated or not: `not.toHaveValue` on a
   * heading is not a pass.
   */
  readonly evaluableNode?: (node: SemanticNode) => boolean;
  /**
   * The matcher reads what an engine withholds on a secure field, its value,
   * text, or attributes; a name is never withheld. A secure node in the sample
   * is denied like the locator getters, negated or not, before the predicate
   * or the failure message reads it: withheld is redacted, not empty or absent.
   */
  readonly readsWithheld?: boolean;
  readonly predicate: (sample: Sample) => boolean;
  readonly describeExpected: string;
  readonly observed: (sample: Sample) => string;
}

type StateKey = 'disabled' | 'checked' | 'selected' | 'expanded' | 'focused';

interface StateMatcherDef {
  readonly key: StateKey;
  readonly expected: boolean;
  readonly describeExpected: string;
  /** Playwright's boolean option that, `false`, waits for the opposite state instead. */
  readonly option?: { readonly key: 'enabled' | 'checked'; readonly describeInverse: string };
}

const STATE_MATCHERS = {
  toBeEnabled: {
    key: 'disabled',
    expected: false,
    describeExpected: 'enabled',
    option: { key: 'enabled', describeInverse: 'disabled' },
  },
  toBeDisabled: { key: 'disabled', expected: true, describeExpected: 'disabled' },
  toBeChecked: {
    key: 'checked',
    expected: true,
    describeExpected: 'checked',
    option: { key: 'checked', describeInverse: 'unchecked' },
  },
  toBeSelected: { key: 'selected', expected: true, describeExpected: 'selected' },
  toBeExpanded: { key: 'expanded', expected: true, describeExpected: 'expanded' },
  toBeFocused: { key: 'focused', expected: true, describeExpected: 'focused' },
} as const satisfies Record<string, StateMatcherDef>;

/**
 * One text matcher: the node field it reads and how `compareText` reads the
 * two strings. `normalize: false` compares the raw field, as a form control's
 * value is, and the failure message prints it raw.
 */
interface TextMatcherDef extends Omit<TextComparison, 'ignoreCase'> {
  readonly field: 'text' | 'value' | 'name';
  /** Whether the matcher takes Playwright's `ignoreCase` option; `toHaveValue` does not. */
  readonly takesIgnoreCase: boolean;
  readonly describeExpected: (pattern: string) => string;
}

const TEXT_MATCHERS = {
  toHaveText: {
    field: 'text',
    mode: 'equals',
    normalize: true,
    takesIgnoreCase: true,
    describeExpected: (pattern) => `text ${pattern}`,
  },
  toContainText: {
    field: 'text',
    mode: 'contains',
    normalize: true,
    takesIgnoreCase: true,
    describeExpected: (pattern) => `text containing ${pattern}`,
  },
  toHaveValue: {
    field: 'value',
    mode: 'equals',
    normalize: false,
    takesIgnoreCase: false,
    describeExpected: (pattern) => `value ${pattern}`,
  },
  toHaveAccessibleName: {
    field: 'name',
    mode: 'equals',
    normalize: true,
    takesIgnoreCase: true,
    describeExpected: (pattern) => `accessible name ${pattern}`,
  },
} as const satisfies Record<string, TextMatcherDef>;

class AsyncExpectationImpl implements AsyncExpectation {
  constructor(
    private readonly internals: LocatorInternals,
    private readonly negated: boolean,
  ) {}

  get not(): AsyncExpectation {
    return new AsyncExpectationImpl(this.internals, !this.negated);
  }

  private get label(): string {
    return describeExpression(this.internals.expression);
  }

  private async poll(spec: MatcherSpec, timeout: number | undefined): Promise<void> {
    const { engine } = this.internals.context;
    const api = `expect.${this.negated ? 'not.' : ''}${spec.name}`;
    await this.internals.context.steps.run('assertion', api, this.label, async () => {
      const deadline = engine.deadline(timeout ?? engine.assertionTimeout);
      let lastSample: Sample = { count: 0, node: null, nodes: [] };
      await pollCondition({
        deadline,
        signal: engine.signal,
        negated: this.negated,
        evaluate: async () => {
          const sample = await this.sample(spec, deadline);
          lastSample = sample;
          if (spec.readsWithheld === true) {
            denySecureRead(sample.node === null ? sample.nodes : [sample.node], this.label);
          }
          if (!this.conditionEvaluable(spec, sample)) return undefined;
          return spec.predicate(sample);
        },
        onTimeout: () => {
          const expected = `${this.negated ? 'not ' : ''}${spec.describeExpected}`;
          const observed = spec.observed(lastSample);
          return new TestError(
            'ASSERTION_FAILED',
            [
              `${api} failed`,
              `locator: ${this.label}`,
              `expected: ${expected}`,
              `observed: ${observed} (match count ${lastSample.count})`,
            ].join('\n'),
            {
              // The same facts, one per field, for a reporter that lays them out.
              details: { locator: this.label, expected, observed, matches: lastSample.count },
            },
          );
        },
      });
    }, { verifies: true });
  }

  /**
   * Single-node matchers require an unambiguous node before their predicate
   * means anything, and may refuse a node that lacks what they read;
   * visibility matchers also accept zero matches.
   */
  private conditionEvaluable(spec: MatcherSpec, sample: Sample): boolean {
    if (spec.wholeSet !== undefined) return true;
    if (sample.node === null) return spec.evaluableWithoutNode === true;
    return spec.evaluableNode?.(sample.node) ?? true;
  }

  private async sample(spec: MatcherSpec, deadline: Deadline): Promise<Sample> {
    const { engine } = this.internals.context;
    if (spec.wholeSet === 'read') {
      const nodes = await engine.readAll(this.internals.expression, deadline);
      return { count: nodes.length, node: null, nodes };
    }
    if (spec.wholeSet === true) {
      const refs = await engine.resolveAll(this.internals.expression, deadline);
      return { count: refs.length, node: null, nodes: [] };
    }
    const { node, count } = await engine.tryRead(this.internals.expression, deadline);
    return { count, node, nodes: [] };
  }

  /**
   * A state matcher. The option named by `def.option` (`enabled`, `checked`)
   * flips the state it waits for, as Playwright's does; it is still a
   * positive poll, so `toBeChecked({ checked: false })` passes at once on an
   * unchecked node instead of holding a negation's grace window.
   */
  private stateMatcher(
    name: keyof typeof STATE_MATCHERS,
    options: { readonly timeout?: number } | undefined,
  ): Promise<void> {
    const def: StateMatcherDef = STATE_MATCHERS[name];
    const api = `expect.${name}`;
    rejectUnknownOptions(api, options, def.option === undefined ? ['timeout'] : [def.option.key, 'timeout']);
    const wanted = def.option === undefined ? true : (booleanOption(api, options, def.option.key) ?? true);
    const expected = wanted ? def.expected : !def.expected;
    return this.poll(
      {
        name,
        predicate: (sample) =>
          sample.node !== null && (sample.node.states?.[def.key] === true) === expected,
        describeExpected: wanted || def.option === undefined ? def.describeExpected : def.option.describeInverse,
        observed: observedState,
      },
      options?.timeout,
    );
  }

  private textMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: TextMatch | readonly TextMatch[],
    options: TextMatcherOptions | undefined,
  ): Promise<void> {
    const def: TextMatcherDef = TEXT_MATCHERS[name];
    const api = `expect.${name}`;
    rejectUnknownOptions(api, options, def.takesIgnoreCase ? ['ignoreCase', 'timeout'] : ['timeout']);
    const ignoreCase = booleanOption(api, options, 'ignoreCase');
    const comparison: TextComparison = {
      mode: def.mode,
      normalize: def.normalize,
      ...(ignoreCase === undefined ? {} : { ignoreCase }),
    };
    if (isTextMatchList(expected)) return this.textListMatcher(name, expected, comparison, options?.timeout);
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name,
        readsWithheld: def.field !== 'name',
        evaluableNode: (node) => readField(def, node) !== undefined,
        predicate: (sample) => {
          const actual = sample.node === null ? undefined : readField(def, sample.node);
          return actual !== undefined && compareText(actual, pattern, comparison);
        },
        describeExpected: def.describeExpected(describeCompared(pattern, comparison)),
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const actual = readField(def, sample.node);
          if (actual === undefined) return `no ${def.field} (not a form control)`;
          return `${def.field} ${printField(def, actual)}`;
        },
      },
      options?.timeout,
    );
  }

  /**
   * The list form. `toHaveText` needs exactly as many matches as entries,
   * each match satisfying the entry at its position; `toContainText` needs
   * each entry contained by a distinct match, in order, as Playwright's does.
   */
  private textListMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: readonly TextMatch[],
    comparison: TextComparison,
    timeout: number | undefined,
  ): Promise<void> {
    const def = TEXT_MATCHERS[name];
    const patterns = expected.map((entry) => toTextPattern(entry, { exact: true }));
    const printed = (node: SemanticNode): string => {
      const actual = readField(def, node);
      return actual === undefined ? `no ${def.field}` : printField(def, actual);
    };
    const satisfies = (node: SemanticNode, pattern: TextPattern): boolean => {
      const actual = readField(def, node);
      return actual !== undefined && compareText(actual, pattern, comparison);
    };
    const matchesList = def.mode === 'contains' ? matchesSubsequence : matchesPositionally;
    const described = patterns.map((pattern) => describeCompared(pattern, comparison));
    return this.poll(
      {
        name,
        readsWithheld: def.field !== 'name',
        wholeSet: 'read',
        predicate: (sample) => matchesList(sample.nodes, patterns, satisfies),
        describeExpected: def.describeExpected(`[${described.join(', ')}]`),
        observed: (sample) => `${def.field} [${sample.nodes.map(printed).join(', ')}]`,
      },
      timeout,
    );
  }

  toBeVisible(options?: { visible?: boolean; timeout?: number }): Promise<void> {
    rejectUnknownOptions('expect.toBeVisible', options, ['visible', 'timeout']);
    const visible = booleanOption('expect.toBeVisible', options, 'visible') ?? true;
    return this.poll(visibilitySpec('toBeVisible', visible), options?.timeout);
  }

  toBeHidden(options?: { timeout?: number }): Promise<void> {
    rejectUnknownOptions('expect.toBeHidden', options, ['timeout']);
    return this.poll(visibilitySpec('toBeHidden', false), options?.timeout);
  }

  toBeAttached(options?: { attached?: boolean; timeout?: number }): Promise<void> {
    rejectUnknownOptions('expect.toBeAttached', options, ['attached', 'timeout']);
    const attached = booleanOption('expect.toBeAttached', options, 'attached') ?? true;
    return this.poll(
      {
        name: 'toBeAttached',
        evaluableWithoutNode: true,
        predicate: (sample) => (sample.node !== null) === attached,
        describeExpected: attached ? 'attached' : 'detached',
        observed: (sample) => (sample.node === null ? 'no node' : 'attached'),
      },
      options?.timeout,
    );
  }

  toBeEnabled(options?: { enabled?: boolean; timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeEnabled', options);
  }

  toBeDisabled(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeDisabled', options);
  }

  toBeChecked(options?: { checked?: boolean; timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeChecked', options);
  }

  toBeSelected(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeSelected', options);
  }

  toBeExpanded(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeExpanded', options);
  }

  toBeFocused(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeFocused', options);
  }

  toHaveText(expected: TextMatch | readonly TextMatch[], options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toHaveText', expected, options);
  }

  toContainText(expected: TextMatch | readonly TextMatch[], options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toContainText', expected, options);
  }

  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveValue', expected, options);
  }

  /**
   * Presence with `(name, options)`, a value with `(name, value, options)`.
   * Only the value form takes `ignoreCase`, as Playwright's does; options in
   * both places is `INVALID_ARGUMENT` rather than one of them dropped.
   */
  toHaveAttribute(
    name: string,
    valueOrOptions?: TextMatch | { timeout?: number },
    options?: TextMatcherOptions,
  ): Promise<void> {
    const api = 'expect.toHaveAttribute';
    let value: TextMatch | undefined;
    let settings: TextMatcherOptions | undefined;
    if (isTextMatch(valueOrOptions)) {
      value = valueOrOptions;
      settings = options;
      rejectUnknownOptions(api, settings, ['ignoreCase', 'timeout']);
    } else {
      if (valueOrOptions !== undefined && options !== undefined) {
        throw new TestError(
          'INVALID_ARGUMENT',
          `${api} takes (name, options) or (name, value, options); the value must be a string or RegExp`,
        );
      }
      settings = valueOrOptions ?? options;
      rejectUnknownOptions(api, settings, ['timeout']);
    }
    const ignoreCase = booleanOption(api, settings, 'ignoreCase');
    const comparison: TextComparison = {
      mode: 'equals',
      normalize: true,
      ...(ignoreCase === undefined ? {} : { ignoreCase }),
    };
    const pattern = value === undefined ? undefined : toTextPattern(value, { exact: true });
    return this.poll(
      {
        name: 'toHaveAttribute',
        readsWithheld: true,
        predicate: (sample) => {
          if (sample.node === null) return false;
          const attribute = attributeOf(sample.node, name);
          return attribute !== null && (pattern === undefined || compareText(attribute, pattern, comparison));
        },
        describeExpected:
          pattern === undefined
            ? `attribute "${name}"`
            : `attribute "${name}" ${describeCompared(pattern, comparison)}`,
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const attribute = attributeOf(sample.node, name);
          return attribute === null
            ? `attribute "${name}" absent`
            : `attribute "${name}" ${JSON.stringify(attribute)}`;
        },
      },
      settings?.timeout,
    );
  }

  toHaveAccessibleName(expected: TextMatch, options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toHaveAccessibleName', expected, options);
  }

  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void> {
    rejectUnknownOptions('expect.toHaveCount', options, ['timeout']);
    return this.poll(
      {
        name: 'toHaveCount',
        wholeSet: true,
        predicate: (sample) => sample.count === expected,
        describeExpected: `count ${expected}`,
        observed: (sample) => `count ${sample.count}`,
      },
      options?.timeout,
    );
  }
}

/** The visibility matchers' spec: `visible` waits for a visible match, otherwise for a hidden one or none. */
function visibilitySpec(name: string, visible: boolean): MatcherSpec {
  if (visible) {
    return {
      name,
      evaluableWithoutNode: true,
      predicate: (sample) => isNodeVisible(sample.node),
      describeExpected: 'visible',
      observed: observedState,
    };
  }
  return {
    name,
    evaluableWithoutNode: true,
    predicate: (sample) => !isNodeVisible(sample.node),
    describeExpected: 'hidden or absent',
    observed: (sample) => (isNodeVisible(sample.node) ? 'visible' : 'hidden'),
  };
}

/** The boolean option `key` of a matcher's options, undefined when absent; anything but a boolean is `INVALID_ARGUMENT`. */
function booleanOption(api: string, options: object | undefined, key: string): boolean | undefined {
  const value = isPlainObject(options) ? options[key] : undefined;
  if (value === undefined || typeof value === 'boolean') return value;
  throw new TestError('INVALID_ARGUMENT', `${api} option "${key}" must be a boolean, got ${typeof value}`);
}

/** A pattern as the comparison reads it: a regexp with the flags `ignoreCase` left it, a folded string marked so. */
function describeCompared(pattern: TextPattern, comparison: TextComparison): string {
  const described = describePattern(withIgnoreCase(pattern, comparison.ignoreCase));
  return pattern.kind === 'string' && comparison.ignoreCase === true ? `${described} ignoring case` : described;
}

/** A list of text matches, as opposed to one string or RegExp. */
function isTextMatchList(expected: TextMatch | readonly TextMatch[]): expected is readonly TextMatch[] {
  return Array.isArray(expected);
}

type NodeSatisfies = (node: SemanticNode, pattern: TextPattern) => boolean;

/** Whether there are exactly as many nodes as patterns, each satisfying the pattern at its position. */
function matchesPositionally(
  nodes: readonly SemanticNode[],
  patterns: readonly TextPattern[],
  satisfies: NodeSatisfies,
): boolean {
  return nodes.length === patterns.length && patterns.every((pattern, index) => satisfies(nodes[index]!, pattern));
}

/**
 * Whether every pattern is satisfied by a distinct node, in order. Greedy:
 * each pattern takes the first node after the previous pattern's that
 * satisfies it, which finds a subsequence whenever one exists.
 */
function matchesSubsequence(
  nodes: readonly SemanticNode[],
  patterns: readonly TextPattern[],
  satisfies: NodeSatisfies,
): boolean {
  let next = 0;
  for (const node of nodes) {
    if (next === patterns.length) break;
    if (satisfies(node, patterns[next]!)) next += 1;
  }
  return next === patterns.length;
}

/**
 * The node's field as the matcher reads it. Text and name read as the empty
 * string when absent, since a node without text has none. A value reads as
 * the empty string only on a control whose role carries one, because a
 * device engine omits an empty value; any other node is not a form control
 * and cannot answer `toHaveValue` at all.
 */
function readField(def: TextMatcherDef, node: SemanticNode): string | undefined {
  const raw = node[def.field];
  if (raw !== undefined) return raw;
  if (def.field !== 'value') return '';
  return isValueControl(node) ? '' : undefined;
}

/** The field as the failure message prints it: normalized when the comparison was, so the message shows what got compared. */
function printField(def: TextMatcherDef, actual: string): string {
  return JSON.stringify(def.normalize ? normalizeText(actual) : actual);
}

function observedState(sample: Sample): string {
  if (sample.node === null) return 'no node';
  const states = sample.node.states ?? {};
  const active = Object.entries(states)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  return active.length === 0 ? 'default states' : `states: ${active.join(', ')}`;
}

export function createAsyncExpectation(internals: LocatorInternals): AsyncExpectation {
  return new AsyncExpectationImpl(internals, false);
}
