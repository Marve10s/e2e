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

/** Matches custom-element roles, names and states across the same roots as native queries. */
export const INTERNALS_ROLE_SELECTOR_ENGINE_SOURCE = `() => {${CLOSED_SHADOW_HELPERS_SOURCE}
  const internals = globalThis[Symbol.for('e2e.elementInternals')];
  const read = (${readSemanticsFunction.toString()});
  const normalize = (text) => text.replace(/\\s+/gu, ' ').trim();
  const properties = ['role', 'ariaLabel', 'ariaChecked', 'ariaDisabled', 'ariaSelected', 'ariaExpanded', 'ariaPressed', 'ariaHidden', 'ariaLevel', 'ariaPlaceholder', 'ariaValueNow', 'ariaValueText'];
  const inheritedDefaults = (el) => {
    for (let current = el; current !== null;) {
      const defaults = internals instanceof WeakMap ? internals.get(current) : undefined;
      if (defaults !== undefined && (
        (!current.hasAttribute('aria-hidden') && typeof defaults.ariaHidden === 'string') ||
        (!current.hasAttribute('aria-disabled') && typeof defaults.ariaDisabled === 'string')
      )) return true;
      const root = current.getRootNode();
      current = current.assignedSlot ?? current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  };
  const stateOf = (el, node, state) => {
    if (state === 'checked' && el instanceof HTMLInputElement) {
      if (el.indeterminate) return 'mixed';
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    }
    if (state === 'checked' || state === 'pressed') {
      const defaults = internals instanceof WeakMap ? internals.get(el) : undefined;
      const value = el.getAttribute('aria-' + state) ?? defaults?.[state === 'checked' ? 'ariaChecked' : 'ariaPressed'];
      if (value === 'mixed') return 'mixed';
      return node.states[state] ?? false;
    }
    if (state === 'selected') return node.states.selected ?? false;
    return node.states[state];
  };
  let native = new WeakSet();
  const queryAll = (root, selector) => {
    if (selector === 'begin') { native = new WeakSet(); return [root]; }
    if (selector === 'record') { native.add(root); return []; }
    const body = JSON.parse(selector);
    const query = body.query;
    const options = { testIdAttribute: body.testIdAttribute, secureFieldSelector: body.secureFieldSelector, mode: { kind: 'node' } };
    const name = query.name;
    const pattern = name?.kind === 'regexp' ? new RegExp(name.source, name.flags) : null;
    const candidates = matchesIn(root, '*', []);
    return candidates.filter((el) => {
      const defaults = internals instanceof WeakMap ? internals.get(el) : undefined;
      const usesDefaults = defaults !== undefined && properties.some((property) => {
        const attribute = property === 'role' ? 'role' : 'aria-' + property.slice(4).toLowerCase();
        return !el.hasAttribute(attribute) && typeof defaults[property] === 'string';
      });
      if (!usesDefaults && !inheritedDefaults(el)) return native.has(el);
      const node = read(el, options);
      if (node.role !== query.value.value) return false;
      if (read(el, { ...options, mode: { kind: 'accessible-hidden' } })) return false;
      if (query.level !== undefined && node.level !== query.level) return false;
      for (const [state, expected] of Object.entries(query.states ?? {})) {
        if (stateOf(el, node, state) !== expected) return false;
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
