/** Records custom-element accessibility defaults before application scripts attach them. */
export const ELEMENT_INTERNALS_INIT_SCRIPT = `(() => {
  const key = Symbol.for('e2e.elementInternals');
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  const attachInternals = HTMLElement.prototype.attachInternals;
  if (attachInternals === undefined) return;
  const internals = new WeakMap();
  Object.defineProperty(globalThis, key, { value: internals });
  HTMLElement.prototype.attachInternals = function () {
    const attached = attachInternals.call(this);
    internals.set(this, attached);
    return attached;
  };
})();`;
