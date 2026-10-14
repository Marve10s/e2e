/** Custom-element accessibility defaults survive hydration in observations and composed role queries. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode, TextPattern } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const signal = new AbortController().signal;
const operation = { signal, timeoutMs: 10_000, runId: 'internals', attemptId: 'a', origin: 'test' } as const;
const cleanup = { signal, timeoutMs: 10_000 };
const surface = new PlaywrightSurface({});
const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-internals-'));

/** A role query using the same expression as screen.getByRole. */
function byRole(role: string, name?: string | TextPattern): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role', value: { kind: 'string', value: role, exact: true },
      ...(name === undefined ? {} : { name: typeof name === 'string' ? { kind: 'string', value: name, exact: true } : name }),
    },
  };
}

/** Every node the engine observed, in tree order. */
function flatten(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

const locate = (expression: LocatorExpression) => surface.locate(expression, operation);
const testIds = async (expression: LocatorExpression) => (await locate(expression)).map((node) => node.testId);

beforeAll(async () => {
  await surface.init({ runId: 'internals', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {},
    headed: false, workerSlot: 0, signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
});

beforeEach(async () => { await surface.open('about:blank', operation); });

afterAll(async () => {
  await surface.endAttempt(cleanup);
  await surface.dispose(cleanup);
  rmSync(artifactsDir, { recursive: true, force: true });
});

it('keeps hydrated roles and names live while present attributes override their defaults', async () => {
  const page = surface.requirePage();
  await page.setContent('<span role="img" aria-label="₹1,234.00" data-testid="amount">₹1,234.00</span>');
  expect(await testIds(byRole('image', '₹1,234.00'))).toEqual(['amount']);
  await page.evaluate(() => {
    customElements.define('x-amount', class extends HTMLElement {
      constructor() {
        super();
        const internals = this.attachInternals();
        internals.role = 'img';
        internals.ariaLabel = '₹1,234.00';
        this.addEventListener('rename', () => { internals.ariaLabel = 'Updated'; });
        this.attachShadow({ mode: 'open' }).innerHTML = '<span>₹1,234.00</span>';
      }
    });
    document.body.innerHTML = '<x-amount data-testid="amount"></x-amount>';
  });
  const observed = flatten((await surface.observe(operation)).root);
  expect(observed.find((node) => node.testId === 'amount')).toMatchObject({ role: 'image', name: '₹1,234.00' });
  expect(await testIds(byRole('image', '₹1,234.00'))).toEqual(['amount']);
  await page.locator('x-amount').evaluate((element) => {
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', 'Override');
    element.dispatchEvent(new Event('rename'));
  });
  expect(await testIds(byRole('button', 'Override'))).toEqual(['amount']);
  expect(await testIds(byRole('image'))).toEqual([]);
  await page.locator('x-amount').evaluate((element) => { element.removeAttribute('role'); element.removeAttribute('aria-label'); });
  expect(await testIds(byRole('image', 'Updated'))).toEqual(['amount']);
  expect(await page.locator('x-amount').evaluate((element) => [element.getAttribute('role'), element.getAttribute('aria-label')])).toEqual([null, null]);
  await page.locator('x-amount').evaluate((element) => { element.setAttribute('aria-label', ''); });
  expect(await testIds(byRole('image', 'Updated'))).toEqual([]);
  expect((await locate(byRole('image')))[0]?.name).toBeUndefined();
  await page.locator('x-amount').evaluate((element) => { element.setAttribute('role', ''); });
  expect(await testIds(byRole('image'))).toEqual([]);
});

it('preserves native and custom order, positions, scopes, filters, and actions across closed roots', async () => {
  const page = surface.requirePage();
  await page.setContent('<div role="group" aria-label="Row"><button data-testid="first">Twin</button><x-control data-testid="second">Drawn</x-control><button data-testid="third">Twin</button></div><x-host></x-host><p id="status">waiting</p>');
  await page.evaluate(() => {
    customElements.define('x-control', class extends HTMLElement {
      constructor() {
        super();
        const internals = this.attachInternals();
        internals.role = 'button';
        internals.ariaLabel = 'Twin';
        this.addEventListener('click', () => { document.querySelector('#status')!.textContent = 'clicked'; });
      }
    });
    document.querySelector('x-host')!.attachShadow({ mode: 'closed' }).innerHTML = '<x-control data-testid="closed">Drawn</x-control>';
  });
  const twins = byRole('button', 'Twin');
  expect(await testIds(twins)).toEqual(['first', 'second', 'third', 'closed']);
  const second: LocatorExpression = { kind: 'index', source: twins, index: 1 };
  expect(await testIds(second)).toEqual(['second']);
  expect(await testIds(byRole('button', { kind: 'regexp', source: '^T.*n$', flags: 'g' }))).toEqual(['first', 'second', 'third', 'closed']);
  const row = byRole('group', 'Row');
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } }, scope: row })).toEqual(['first', 'second', 'third']);
  expect(await locate({ kind: 'filter', source: row, has: second })).toHaveLength(1);
  const [button] = await locate(second);
  await surface.perform(button!.ref, { kind: 'tap' }, operation);
  expect(await page.locator('#status').textContent()).toBe('clicked');
});

it('tracks the first app script in frames and in a replacement context', async () => {
  const html = '<x-amount data-testid="amount"></x-amount><script>customElements.define("x-amount", class extends HTMLElement { constructor() { super(); const internals = this.attachInternals(); internals.role = "img"; internals.ariaLabel = "Amount"; this.textContent = "123"; } });</script>';
  const open = async () => {
    await surface.requireContext().route('http://fixture.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: route.request().url().endsWith('/frame') ? html : `${html}<iframe src="http://fixture.test/frame"></iframe>`,
    }));
    await surface.open('http://fixture.test/', operation);
    await surface.requirePage().frames()[1]!.waitForLoadState();
  };
  await open();
  const framed: LocatorExpression = { kind: 'frame', selector: 'iframe', source: byRole('image', 'Amount') };
  expect(await testIds(framed)).toEqual(['amount']);
  await surface.reset(operation);
  await open();
  expect(await testIds(byRole('image', 'Amount'))).toEqual(['amount']);
});

it('keeps native role results unchanged when an unrelated element attaches internals', async () => {
  const page = surface.requirePage();
  await page.setContent('<div inert><button data-testid="save">Save</button></div>');
  expect(await testIds(byRole('button', 'Save'))).toEqual(['save']);
  await page.evaluate(() => {
    customElements.define('x-plain', class extends HTMLElement {
      constructor() { super(); this.attachInternals(); }
    });
    const plain = document.createElement('x-plain');
    plain.textContent = 'plain';
    document.body.append(plain);
  });
  expect(await testIds(byRole('button', 'Save'))).toEqual(['save']);
});

it('reads checked and pressed states from internals defaults', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-check data-testid="box">Box</x-check><x-press data-testid="press">Press</x-press>');
  await page.evaluate(() => {
    customElements.define('x-check', class extends HTMLElement {
      constructor() { super(); const internals = this.attachInternals(); internals.role = 'checkbox'; internals.ariaChecked = 'true'; }
    });
    customElements.define('x-press', class extends HTMLElement {
      constructor() { super(); const internals = this.attachInternals(); internals.role = 'button'; internals.ariaPressed = 'true'; }
    });
  });
  const role = (value: string, states: Record<string, boolean>): LocatorExpression => ({
    kind: 'query', query: { kind: 'role', value: { kind: 'string', value, exact: true }, states },
  });
  expect(await testIds(role('checkbox', { checked: true }))).toEqual(['box']);
  expect(await testIds(role('checkbox', { checked: false }))).toEqual([]);
  expect(await testIds(role('button', { pressed: true }))).toEqual(['press']);
  expect(await testIds(role('button', { pressed: false }))).toEqual([]);
});

it('keeps mixed checked and pressed states out of boolean false queries', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-toggle role="checkbox" aria-checked="mixed" data-testid="mixed">Toggle</x-toggle><x-toggle role="checkbox" aria-checked="false" data-testid="unchecked">Toggle</x-toggle><x-toggle role="button" aria-pressed="mixed" data-testid="mixed-pressed">Toggle</x-toggle><x-toggle role="button" aria-pressed="false" data-testid="released">Toggle</x-toggle>');
  await page.evaluate(() => {
    customElements.define('x-toggle', class extends HTMLElement {
      constructor() {
        super();
        this.attachInternals().ariaLabel = 'Toggle';
      }
    });
  });
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: false } } })).toEqual(['unchecked']);
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, states: { pressed: false } } })).toEqual(['released']);
});

it('uses internals defaults in native controls\' names and excludes hidden descendants', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-hidden id="label" style="display:inline-block">Hidden label<button data-testid="hidden">Child</button></x-hidden><button aria-labelledby="label" data-testid="referenced">Fallback</button><button data-testid="content">Save<x-hidden>ignored</x-hidden></button><x-label id="name">ignored</x-label><button aria-labelledby="name" data-testid="named">Fallback</button>');
  await page.evaluate(() => {
    customElements.define('x-hidden', class extends HTMLElement {
      constructor() { super(); this.attachInternals().ariaHidden = 'true'; }
    });
    customElements.define('x-label', class extends HTMLElement {
      constructor() { super(); const internals = this.attachInternals(); internals.role = 'img'; internals.ariaLabel = 'Label'; }
    });
  });
  expect(await testIds(byRole('button'))).toEqual(['referenced', 'content', 'named']);
  expect(await testIds(byRole('button', 'Save'))).toEqual(['content']);
  expect(await testIds(byRole('button', 'Saveignored'))).toEqual([]);
  expect(await testIds(byRole('button', 'Label'))).toEqual(['named']);
  const observed = flatten((await surface.observe(operation)).root);
  expect(observed.find((node) => node.testId === 'referenced')?.name).toBe('Hidden label Child');
});
