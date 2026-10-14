/** Records custom-element accessibility defaults before application scripts attach them. */

/**
 * Where the init script below records ElementInternals, and where the
 * in-page reader and the role selector look for them. The reader is
 * serialized into the page and cannot import this constant, so the literal
 * is repeated inside it; the two must agree, like `CLOSED_SHADOW_ROOTS_KEY`.
 *
 * The record is a typed `{ elements, count }`: a `WeakMap` from element to
 * its internals, and the number attached so far, which lets a selector
 * answer for a page that attached none without walking it.
 */
export const ELEMENT_INTERNALS_KEY = 'e2e.elementInternals';

/** Context init script that keeps every attached ElementInternals reachable for the reader. */
export const ELEMENT_INTERNALS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(ELEMENT_INTERNALS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  const attachInternals = HTMLElement.prototype.attachInternals;
  if (attachInternals === undefined) return;
  const record = { elements: new WeakMap(), count: 0 };
  Object.defineProperty(globalThis, key, { value: record });
  HTMLElement.prototype.attachInternals = function () {
    const attached = attachInternals.call(this);
    record.elements.set(this, attached);
    record.count += 1;
    return attached;
  };
})();`;
