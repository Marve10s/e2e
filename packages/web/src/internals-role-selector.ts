import type { SemanticQuery } from 'e2e/engine';
import { CLOSED_SHADOW_HELPERS_SOURCE } from './closed-shadow.ts';
import { readSemanticsFunction } from './in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR } from './read-node.ts';

/** Role queries read tracked custom elements through the same semantics as observations. */
export const INTERNALS_ROLE_SELECTOR_ENGINE = 'e2e-internals-role';

/** Encodes the role query without losing regular-expression flags or quoted names. */
export function internalsRoleSelector(query: SemanticQuery, testIdAttribute: string): string {
  return `${INTERNALS_ROLE_SELECTOR_ENGINE}=${JSON.stringify({ query, testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR })}`;
}

/** Begins one synchronous query without retaining any earlier native matches. */
export const BEGIN_ROLE_SELECTOR = `${INTERNALS_ROLE_SELECTOR_ENGINE}=begin`;

/** Records native matches without passing them to a union sorter that cannot walk closed shadow roots. */
export const RECORD_ROLE_SELECTOR = `${INTERNALS_ROLE_SELECTOR_ENGINE}=record`;
export const INTERNALS_PRESENT_SELECTOR = `${INTERNALS_ROLE_SELECTOR_ENGINE}=present`;
export const RECORD_NAME_CANDIDATES_SELECTOR = `${INTERNALS_ROLE_SELECTOR_ENGINE}=names`;

/** Matches custom-element roles, names and states across the same roots as native queries. */
export const INTERNALS_ROLE_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const internals = globalThis[Symbol.for('e2e.elementInternals')];
  const read = (${readSemanticsFunction.toString()});
  const normalize = (text) => text.replace(/\\s+/gu, ' ').trim();
  const usesDefaults = (el) => {
    const defaults = internals.get(el);
    return defaults !== undefined && [['role', 'role'], ['aria-label', 'ariaLabel'], ['aria-hidden', 'ariaHidden']]
      .some(([attribute, property]) => !el.hasAttribute(attribute) && typeof defaults[property] === 'string');
  };
  const namingUsesDefaults = (el) => {
    const tree = el.getRootNode();
    const targets = [el, ...(el.getAttribute('aria-labelledby') ?? '').trim().split(/\\s+/)
      .map((id) => tree.getElementById(id)).filter((target) => target !== null)];
    return targets.some((target) => {
      const nodes = matchesIn(target, '*', [target]);
      for (const closed of closedRootsUnder(target, [])) matchesIn(closed, '*', nodes);
      return nodes.some(usesDefaults);
    });
  };
  const stateOf = (el, node, state) => {
    if ((state === 'checked' || state === 'pressed') && el.getAttribute('aria-' + state) === 'mixed') return 'mixed';
    if (state === 'checked' || state === 'pressed' || state === 'selected') return node.states[state] ?? false;
    return node.states[state];
  };
  let native = new Set();
  let named = new Set();
  const queryAll = (root, selector) => {
    if (selector === 'begin') { native = new Set(); named = new Set(); return [root]; }
    if (selector === 'record') { native.add(root); return []; }
    if (selector === 'names') { named.add(root); return []; }
    if (selector === 'present') return internals?.count > 0 ? [root] : [];
    if (internals === undefined || internals.count === 0) return [...native];
    const body = JSON.parse(selector);
    const query = body.query;
    const options = { testIdAttribute: body.testIdAttribute, secureFieldSelector: body.secureFieldSelector, mode: { kind: 'node' } };
    const name = query.name;
    const pattern = name?.kind === 'regexp' ? new RegExp(name.source, name.flags) : null;
    const candidates = matchesIn(root, '*', []);
    return candidates.filter((el) => {
      if (!usesDefaults(el) && !(name !== undefined && named.has(el) && namingUsesDefaults(el)))
        return native.has(el) && !read(el, { ...options, mode: { kind: 'accessible-hidden' } });
      const node = read(el, options);
      if (node.role !== query.value.value) return false;
      if (read(el, { ...options, mode: { kind: 'accessible-hidden' } })) return false;
      if (query.level !== undefined && node.level !== query.level) return false;
      for (const [state, expected] of Object.entries(query.states ?? {})) {
        if (!named.has(el) && stateOf(el, node, state) !== expected) return false;
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
