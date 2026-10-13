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

it('keeps the image and its name after the server fallback hydrates', async () => {
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
        this.attachShadow({ mode: 'open' }).innerHTML = '<span>₹1,234.00</span>';
      }
    });
    document.body.innerHTML = '<x-amount data-testid="amount"></x-amount>';
  });
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  expect(nodes.find((node) => node.role?.value === 'image')?.name?.value).toBe('₹1,234.00');
  const observed = flatten((await surface.observe(operation)).root);
  expect(observed.find((node) => node.testId === 'amount')).toMatchObject({ role: 'image', name: '₹1,234.00' });
  expect(await testIds(byRole('image', '₹1,234.00'))).toEqual(['amount']);
});

it('uses live defaults and lets present attributes override them without changing the DOM', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-control data-testid="control" role="button" aria-label="Override">Rendered text</x-control>');
  await page.evaluate(() => {
    customElements.define('x-control', class extends HTMLElement {
      readonly internals = this.attachInternals();
      constructor() {
        super();
        this.internals.role = 'img';
        this.internals.ariaLabel = 'Default';
        this.addEventListener('rename', () => { this.internals.ariaLabel = 'Updated'; });
      }
    });
  });
  expect(await testIds(byRole('button', 'Override'))).toEqual(['control']);
  expect(await testIds(byRole('image', 'Default'))).toEqual([]);
  await page.locator('x-control').evaluate((element) => {
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    element.dispatchEvent(new Event('rename'));
  });
  expect(await testIds(byRole('image', 'Updated'))).toEqual(['control']);
  expect(await page.locator('x-control').evaluate((element) => [element.getAttribute('role'), element.getAttribute('aria-label')])).toEqual([null, null]);
  await page.locator('x-control').evaluate((element) => { element.setAttribute('aria-label', ''); });
  expect(await testIds(byRole('image', 'Updated'))).toEqual([]);
  expect((await locate(byRole('image')))[0]?.name).toBeUndefined();
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

it('reads default states and names while keeping accessibility exclusion separate from box size', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-choice data-testid="choice">Choice</x-choice><x-choice aria-checked="false" data-testid="unchecked">Choice</x-choice><x-heading data-testid="heading">Heading</x-heading><x-choice aria-hidden="true" data-testid="hidden">Hidden</x-choice><x-choice style="display:inline-block;width:0;height:0" data-testid="boxless"></x-choice>');
  await page.evaluate(() => {
    customElements.define('x-choice', class extends HTMLElement {
      constructor() {
        super();
        const internals = this.attachInternals();
        internals.role = 'checkbox';
        internals.ariaLabel = '  Remember   me  ';
        internals.ariaChecked = 'true';
      }
    });
    customElements.define('x-heading', class extends HTMLElement {
      constructor() {
        super();
        const internals = this.attachInternals();
        internals.role = 'heading';
        internals.ariaLevel = '3';
      }
    });
  });
  expect(await testIds(byRole('checkbox', 'Remember me'))).toEqual(['choice', 'unchecked', 'boxless']);
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: false } } })).toEqual(['unchecked']);
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 3 } })).toEqual(['heading']);
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 2 } })).toEqual([]);
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

it('applies inherited internals visibility and disabled states to native descendants', async () => {
  const page = surface.requirePage();
  await page.setContent('<x-panel data-hidden="true"><button data-testid="hidden">Save</button></x-panel><x-panel data-disabled="true"><button data-testid="disabled">Save</button><button aria-disabled="false" data-testid="enabled">Save</button><input type="checkbox" checked aria-checked="mixed" data-testid="native-checkbox"></x-panel>');
  await page.evaluate(() => {
    customElements.define('x-panel', class extends HTMLElement {
      constructor() {
        super();
        const internals = this.attachInternals();
        internals.ariaHidden = this.getAttribute('data-hidden');
        internals.ariaDisabled = this.getAttribute('data-disabled');
      }
    });
  });
  expect(await testIds(byRole('button', 'Save'))).toEqual(['disabled', 'enabled']);
  const disabled: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, states: { disabled: true } } };
  expect(await testIds(disabled)).toEqual(['disabled']);
  expect(await testIds({ kind: 'query', query: { ...disabled.query, states: { disabled: false } } })).toEqual(['enabled']);
  expect(await testIds({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: true } } })).toEqual(['native-checkbox']);
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
