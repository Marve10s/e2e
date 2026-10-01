/**
 * The options of the locator matchers. Playwright's boolean flags
 * (`visible`, `attached`, `enabled`, `checked`) flip the state a matcher
 * waits for and `ignoreCase` changes how text compares; a test ported from
 * Playwright must get that meaning, not the default. Any other key, or a
 * flag that is not a boolean, fails before the matcher polls or records a
 * step.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type SemanticNode } from '../../src/engine/index.ts';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import type { AsyncExpectation, Locator } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const NODES: SemanticNode[] = [
  { ref: { id: 'h1', revision: '' }, role: 'heading', name: 'Dashboard', text: 'Dashboard', level: 1 },
  { ref: { id: 'ghost', revision: '' }, role: 'status', name: 'Ghost', text: 'Ghost', states: { hidden: true } },
  { ref: { id: 'notify', revision: '' }, role: 'checkbox', name: 'Notifications', states: { checked: false } },
  { ref: { id: 'dark', revision: '' }, role: 'switch', name: 'Dark mode', states: { checked: true } },
  { ref: { id: 'submit', revision: '' }, role: 'button', name: 'Submit' },
  { ref: { id: 'locked', revision: '' }, role: 'button', name: 'Locked', states: { disabled: true } },
  { ref: { id: 'search', revision: '' }, role: 'searchbox', name: 'Search', value: 'Hello' },
  {
    ref: { id: 'card', revision: '' },
    role: 'region',
    name: 'Card',
    testId: 'card',
    text: 'Card Body',
    attributes: { 'data-state': 'Open' },
  },
  { ref: { id: 'todo-1', revision: '' }, role: 'listitem', testId: 'todo', text: 'Write spec' },
  { ref: { id: 'todo-2', revision: '' }, role: 'listitem', testId: 'todo', text: 'Ship runner' },
];

/** A screen over the reference nodes, counting every lookup, with the step recorder behind it. */
function fixture() {
  let lookups = 0;
  const { screen, steps } = screenOver({
    locate: (expression) => {
      lookups += 1;
      return resolveExpression(expression, NODES);
    },
    observe: () => snapshot(NODES),
    timeoutMs: 2_000,
  });
  return { screen, steps, lookups: () => lookups };
}

const fast = { timeout: 50 };

describe('locator matcher boolean options', () => {
  it('flip the state a positive matcher waits for, and pass at once', async () => {
    const { screen, steps } = fixture();
    await e2eExpect(screen.getByText('Ghost')).toBeVisible({ visible: false });
    await e2eExpect(screen.getByText('Never rendered')).toBeVisible({ visible: false });
    await e2eExpect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ visible: true });
    await e2eExpect(screen.getByText('Never rendered')).toBeAttached({ attached: false });
    await e2eExpect(screen.getByText('Ghost')).toBeAttached({ attached: true });
    await e2eExpect(screen.getByRole('button', { name: 'Locked' })).toBeEnabled({ enabled: false });
    await e2eExpect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled({ enabled: true });
    await e2eExpect(screen.getByRole('checkbox', { name: 'Notifications' })).toBeChecked({ checked: false });
    await e2eExpect(screen.getByRole('switch', { name: 'Dark mode' })).toBeChecked({ checked: true });
    const recorded = steps.all();
    expect(recorded.map((entry) => entry.api)).toEqual([
      'expect.toBeVisible',
      'expect.toBeVisible',
      'expect.toBeVisible',
      'expect.toBeAttached',
      'expect.toBeAttached',
      'expect.toBeEnabled',
      'expect.toBeEnabled',
      'expect.toBeChecked',
      'expect.toBeChecked',
    ]);
    // Positive polls: the first sample holds, so none waits out the 1000 ms negation window.
    for (const entry of recorded) expect(entry.durationMs, entry.api).toBeLessThan(900);
  });

  it('fail on the state they no longer accept, naming the flipped expectation', async () => {
    const { screen } = fixture();
    const cases: [Promise<void>, string, string][] = [
      [e2eExpect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ visible: false, ...fast }), 'expected: hidden or absent', 'observed: visible'],
      [e2eExpect(screen.getByText('Ghost')).toBeVisible({ visible: true, ...fast }), 'expected: visible', 'observed: states: hidden'],
      [e2eExpect(screen.getByText('Ghost')).toBeAttached({ attached: false, ...fast }), 'expected: detached', 'observed: attached'],
      [e2eExpect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled({ enabled: false, ...fast }), 'expected: disabled', 'observed: default states'],
      [e2eExpect(screen.getByRole('switch', { name: 'Dark mode' })).toBeChecked({ checked: false, ...fast }), 'expected: unchecked', 'observed: states: checked'],
      [e2eExpect(screen.getByRole('checkbox', { name: 'Notifications' })).toBeChecked({ checked: true, ...fast }), 'expected: checked', 'observed: default states'],
    ];
    for (const [assertion, expected, observed] of cases) {
      await expect(assertion).rejects.toMatchObject({
        code: 'ASSERTION_FAILED',
        message: expect.stringMatching(new RegExp(`${expected}\\n.*${observed}`)),
      });
    }
  });

  it('compose with .not: the negation waits for the original state', async () => {
    const { screen } = fixture();
    const soon = { timeout: 300 };
    await e2eExpect(screen.getByRole('heading', { name: 'Dashboard' })).not.toBeVisible({ visible: false, ...soon });
    await e2eExpect(screen.getByText('Ghost')).not.toBeAttached({ attached: false, ...soon });
    await e2eExpect(screen.getByRole('button', { name: 'Submit' })).not.toBeEnabled({ enabled: false, ...soon });
    await e2eExpect(screen.getByRole('switch', { name: 'Dark mode' })).not.toBeChecked({ checked: false, ...soon });
    await expect(
      e2eExpect(screen.getByRole('checkbox', { name: 'Notifications' })).not.toBeChecked({ checked: false, ...fast }),
    ).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('expected: not unchecked') });
    await expect(
      e2eExpect(screen.getByText('Ghost')).not.toBeVisible({ visible: false, ...fast }),
    ).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('expected: not hidden or absent') });
  });
});

describe('locator matcher ignoreCase', () => {
  it('folds a string and adds the i flag to a RegExp, single and list forms', async () => {
    const { screen } = fixture();
    const heading = screen.getByRole('heading', { level: 1 });
    await e2eExpect(heading).toHaveText('DASHBOARD', { ignoreCase: true });
    await e2eExpect(heading).toHaveText(/^dash/, { ignoreCase: true });
    await e2eExpect(heading).toHaveAccessibleName('dashboard', { ignoreCase: true });
    await e2eExpect(screen.getByTestId('card')).toContainText('BODY', { ignoreCase: true });
    await e2eExpect(screen.getByTestId('card')).toHaveAttribute('data-state', 'OPEN', { ignoreCase: true });
    await e2eExpect(screen.getByTestId('card')).toHaveAttribute('data-state', /^open$/, { ignoreCase: true });
    await e2eExpect(screen.getByTestId('todo')).toHaveText(['WRITE SPEC', /^ship/], { ignoreCase: true });
    await e2eExpect(screen.getByTestId('todo')).toContainText(['SPEC', 'RUNNER'], { ignoreCase: true });
  });

  it('is case-sensitive without it, and ignoreCase: false drops the i flag', async () => {
    const { screen } = fixture();
    const heading = screen.getByRole('heading', { level: 1 });
    const soon = { timeout: 300 };
    await e2eExpect(heading).not.toHaveText('DASHBOARD', soon);
    await e2eExpect(heading).not.toHaveText(/^dash/i, { ignoreCase: false, ...soon });
    await e2eExpect(heading).toHaveText(/^Dash/i, { ignoreCase: false });
    await e2eExpect(screen.getByTestId('todo')).not.toHaveText(['WRITE SPEC', 'SHIP RUNNER'], soon);
    await e2eExpect(screen.getByTestId('card')).not.toHaveAttribute('data-state', 'OPEN', soon);
  });

  it('names the case-folded comparison in a failure, negated too', async () => {
    const { screen } = fixture();
    const heading = screen.getByRole('heading', { level: 1 });
    await expect(e2eExpect(heading).toHaveText('DASHBOARD', fast)).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: text "DASHBOARD"\n'),
    });
    await expect(e2eExpect(heading).not.toHaveText('DASHBOARD', { ignoreCase: true, ...fast })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: not text "DASHBOARD" ignoring case'),
    });
    await expect(e2eExpect(heading).toHaveText(/^DASH$/, { ignoreCase: true, ...fast })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: text /^DASH$/i'),
    });
    await expect(e2eExpect(heading).toHaveText(/^dash/i, { ignoreCase: false, ...fast })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: text /^dash/\n'),
    });
    await expect(
      e2eExpect(screen.getByTestId('todo')).toHaveText(['WRITE SPEC', 'Release'], { ignoreCase: true, ...fast }),
    ).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: text ["WRITE SPEC" ignoring case, "Release" ignoring case]'),
    });
  });
});

type Call = (expectation: AsyncExpectation, locator: Locator) => Promise<void>;

/** Every matcher called with an option it does not take, or a flag that is not a boolean, and the message it must throw. */
const REJECTIONS: [string, Call, string][] = [
  ['toBeVisible', (e) => e.toBeVisible(invalid({ visible: 'false' })), 'expect.toBeVisible option "visible" must be a boolean, got string'],
  ['toBeVisible', (e) => e.toBeVisible(invalid({ visibel: false })), 'expect.toBeVisible options has no key "visibel"; it takes visible, timeout'],
  ['toBeHidden', (e) => e.toBeHidden(invalid({ visible: true })), 'expect.toBeHidden options has no key "visible"; it takes timeout'],
  ['toBeAttached', (e) => e.toBeAttached(invalid({ attached: 0 })), 'expect.toBeAttached option "attached" must be a boolean, got number'],
  ['toBeEnabled', (e) => e.toBeEnabled(invalid({ enabled: 'no' })), 'expect.toBeEnabled option "enabled" must be a boolean, got string'],
  ['toBeDisabled', (e) => e.toBeDisabled(invalid({ disabled: false })), 'expect.toBeDisabled options has no key "disabled"; it takes timeout'],
  ['toBeChecked', (e) => e.toBeChecked(invalid({ indeterminate: true })), 'expect.toBeChecked options has no key "indeterminate"; it takes checked, timeout'],
  ['toBeSelected', (e) => e.toBeSelected(invalid({ selected: false })), 'expect.toBeSelected options has no key "selected"; it takes timeout'],
  ['toBeExpanded', (e) => e.toBeExpanded(invalid({ expanded: false })), 'expect.toBeExpanded options has no key "expanded"; it takes timeout'],
  ['toBeFocused', (e) => e.toBeFocused(invalid({ signal: new AbortController().signal })), 'expect.toBeFocused options has no key "signal"; it takes timeout'],
  ['toHaveText', (e) => e.toHaveText('Dashboard', invalid({ useInnerText: true })), 'expect.toHaveText options has no key "useInnerText"; it takes ignoreCase, timeout'],
  ['toHaveText', (e) => e.toHaveText(['Dashboard'], invalid({ ignoreCase: 'yes' })), 'expect.toHaveText option "ignoreCase" must be a boolean, got string'],
  ['toContainText', (e) => e.toContainText('Dash', invalid({ useInnerText: false })), 'expect.toContainText options has no key "useInnerText"; it takes ignoreCase, timeout'],
  ['toHaveValue', (e) => e.toHaveValue('x', invalid({ ignoreCase: true })), 'expect.toHaveValue options has no key "ignoreCase"; it takes timeout'],
  ['toHaveAttribute', (e) => e.toHaveAttribute('data-state', invalid({ ignoreCase: true })), 'expect.toHaveAttribute options has no key "ignoreCase"; it takes timeout'],
  ['toHaveAttribute', (e) => e.toHaveAttribute('data-state', 'open', invalid({ exact: true })), 'expect.toHaveAttribute options has no key "exact"; it takes ignoreCase, timeout'],
  ['toHaveAttribute', (e) => e.toHaveAttribute('data-state', invalid({ timeout: 50 }), { timeout: 50 }), 'expect.toHaveAttribute takes (name, options) or (name, value, options)'],
  ['toHaveAccessibleName', (e) => e.toHaveAccessibleName('Dashboard', invalid({ exact: false })), 'expect.toHaveAccessibleName options has no key "exact"; it takes ignoreCase, timeout'],
  ['toHaveCount', (e) => e.toHaveCount(1, invalid({ timout: 50 })), 'expect.toHaveCount options has no key "timout"; it takes timeout'],
  ['toHaveCount', (e) => e.toHaveCount(1, invalid('fast')), 'expect.toHaveCount options must be a plain object'],
];

describe('locator matcher option validation', () => {
  it.each(REJECTIONS)('%s rejects a bad option before any lookup or step: %s', async (_name, call, message) => {
    for (const negated of [false, true]) {
      const { screen, steps, lookups } = fixture();
      const locator = screen.getByRole('heading', { level: 1 });
      const expectation = negated ? e2eExpect(locator).not : e2eExpect(locator);
      await expect(Promise.resolve().then(() => call(expectation, locator))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining(message),
      });
      expect(lookups()).toBe(0);
      expect(steps.all()).toEqual([]);
    }
  });

  it('keeps the presence form of toHaveAttribute when the value is undefined', async () => {
    const { screen } = fixture();
    await e2eExpect(screen.getByTestId('card')).toHaveAttribute('data-state', invalid(undefined), { timeout: 300 });
  });
});
