/**
 * The selector engine a role query resolves through. It searches the scope
 * and the closed shadow roots under it in one walk, so light-DOM and closed
 * matches keep the order the roots are searched in; a union of Playwright's
 * native matches with a second locator cannot, because its sorter cannot
 * walk a closed root and drops or misorders the matches inside one.
 *
 * Every candidate is read through the same reader as observations, which
 * reads ElementInternals defaults where an attribute is absent. Native
 * candidates therefore agree with Playwright's own matching by the
 * reader's rules, and a candidate is hidden for a role query by
 * Playwright's rule — an `aria-hidden` (attribute or internals default) on
 * it or an ancestor, a `display: none` ancestor, or its own computed
 * `visibility` — never by the tree's render rules (inert, box size), so an
 * unrelated `attachInternals()` cannot change a native result.
 */

import type { SemanticQuery } from 'e2e/engine';
import { CLOSED_SHADOW_HELPERS_SOURCE } from './closed-shadow.ts';
import { ELEMENT_INTERNALS_KEY } from './element-internals.ts';
import { readSemanticsFunction } from './in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR } from './read-node.ts';

/** Playwright selector engine name; `e2e-internals-role=<json>` matches the role query the JSON encodes. */
export const INTERNALS_ROLE_SELECTOR_ENGINE = 'e2e-internals-role';

/** Encodes the role query without losing regular-expression flags or quoted names. */
export function internalsRoleSelector(query: SemanticQuery, testIdAttribute: string): string {
  return `${INTERNALS_ROLE_SELECTOR_ENGINE}=${JSON.stringify({ query, testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR })}`;
}

/** Matches roles, names and states across the scope and the closed roots under it, in search order. */
export const INTERNALS_ROLE_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const record = globalThis[Symbol.for(${JSON.stringify(ELEMENT_INTERNALS_KEY)})];
  const internals = record?.elements;
  const read = (${readSemanticsFunction.toString()});
  const normalize = (text) => text.replace(/\\s+/gu, ' ').trim();
  const attributeOf = (el, attribute, property) => el.getAttribute(attribute) ?? internals?.get(el)?.[property] ?? null;
  const parentOrHostOf = (el) => {
    if (el.parentElement !== null) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const hiddenForRole = (el) => {
    const view = el.ownerDocument.defaultView;
    if (view === null) return true;
    if (view.getComputedStyle(el).visibility !== 'visible') return true;
    for (let current = el; current !== null; current = current.assignedSlot ?? parentOrHostOf(current)) {
      if ((attributeOf(current, 'aria-hidden', 'ariaHidden') ?? '').toLowerCase() === 'true') return true;
      const style = view.getComputedStyle(current);
      if (style.display === 'none') return true;
      if (current !== el && style.getPropertyValue('content-visibility') === 'hidden') return true;
    }
    return false;
  };
  const stateMatches = (node, state, expected) => (node.states[state] ?? false) === expected;
  const queryAll = (root, selector) => {
    const body = JSON.parse(selector);
    const query = body.query;
    const options = { testIdAttribute: body.testIdAttribute, secureFieldSelector: body.secureFieldSelector, mode: { kind: 'node' } };
    const name = query.name;
    const pattern = name?.kind === 'regexp' ? new RegExp(name.source, name.flags) : null;
    const candidates = matchesIn(root, '*', []);
    for (const closed of closedRootsUnder(root, [])) matchesIn(closed, '*', candidates);
    return candidates.filter((el) => {
      // A mixed checked or pressed state is neither true nor false.
      for (const [state, expected] of Object.entries(query.states ?? {})) {
        if ((state === 'checked' || state === 'pressed')
          && attributeOf(el, 'aria-' + state, state === 'checked' ? 'ariaChecked' : 'ariaPressed') === 'mixed'
          && typeof expected === 'boolean') return false;
      }
      if (hiddenForRole(el)) return false;
      const node = read(el, options);
      if (node.role !== query.value.value) return false;
      if (query.level !== undefined && node.level !== query.level) return false;
      for (const [state, expected] of Object.entries(query.states ?? {})) {
        if (!stateMatches(node, state, expected)) return false;
      }
      if (name === undefined) return true;
      const actual = normalize(node.name ?? '');
      if (pattern !== null) { pattern.lastIndex = 0; return pattern.test(actual); }
      const expected = normalize(name.value);
      return name.exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
    });
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;
