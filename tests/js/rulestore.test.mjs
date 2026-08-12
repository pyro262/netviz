import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, loadPatch, savePatch, clearPatch, withPersistence }
  from '../../netviz/static/js/rulestore.js';

/** The three methods of Storage this module uses, and nothing else. A real
 *  localStorage is not needed to decide any of this. */
function fakeStorage(initial = {}, opts = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { if (opts.throwOnWrite) throw new Error('quota'); data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
}

test('a saved patch round-trips', () => {
  const s = fakeStorage();
  const patch = { 'arcs.rules': [{ match: 'DE', colour: '#ff8800' }], 'rail.enabled': true };
  assert.equal(savePatch(s, patch).ok, true);
  assert.deepEqual(loadPatch(s).patch, patch);
  assert.equal(loadPatch(s).error, null);
});

test('no stored value is not an error', () => {
  // A fresh kiosk has never been configured. That is the normal case, not a
  // fault, and it must not warn on every boot.
  const out = loadPatch(fakeStorage());
  assert.deepEqual(out.patch, {});
  assert.equal(out.error, null);
});

test('a corrupt value reports an error and yields no patch', () => {
  // Deliberately NOT cleared: somebody may want to recover it by hand, and
  // blanking a wall over a bad localStorage entry is worse than ignoring it.
  const s = fakeStorage({ [KEY]: '{not json' });
  const out = loadPatch(s);
  assert.deepEqual(out.patch, {});
  assert.ok(out.error);
  assert.equal(s.getItem(KEY), '{not json');
});

test('a stored value that is not an object is refused like corruption', () => {
  assert.ok(loadPatch(fakeStorage({ [KEY]: '[1,2,3]' })).error);
  assert.ok(loadPatch(fakeStorage({ [KEY]: '"DE"' })).error);
});

test('storage that throws is reported, never fatal', () => {
  // Private browsing and a disabled-storage kiosk both do this. A display with
  // no storage is a working display.
  const out = savePatch(fakeStorage({}, { throwOnWrite: true }), { 'rail.enabled': true });
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test('clear removes the key', () => {
  const s = fakeStorage({ [KEY]: '{"rail.enabled":true}' });
  assert.equal(clearPatch(s).ok, true);
  assert.equal(s.getItem(KEY), null);
});

test('withPersistence stores accepted keys and returns the result untouched', () => {
  const s = fakeStorage();
  const calls = [];
  const base = { apply(p) { calls.push(p); return { applied: ['rail.enabled'], rejected: [] }; } };
  const wrapped = withPersistence(base, s);
  const out = wrapped.apply({ 'rail.enabled': true });
  assert.deepEqual(out, { applied: ['rail.enabled'], rejected: [] });
  assert.deepEqual(calls, [{ 'rail.enabled': true }]);
  assert.deepEqual(loadPatch(s).patch, { 'rail.enabled': true });
});

test('a rejected key is never stored', () => {
  // Storing it would resurrect the same rejection on every boot, for ever.
  const s = fakeStorage();
  const base = { apply: () => ({ applied: [], rejected: [{ path: 'arcs.rules', why: 'bad' }] }) };
  withPersistence(base, s).apply({ 'arcs.rules': [{ match: 'nonsense' }] });
  assert.deepEqual(loadPatch(s).patch, {});
});

test('a later patch merges onto the stored one rather than replacing it', () => {
  const s = fakeStorage();
  const base = { apply: (p) => ({ applied: Object.keys(p), rejected: [] }) };
  const wrapped = withPersistence(base, s);
  wrapped.apply({ 'rail.enabled': true });
  wrapped.apply({ 'layers.stars': false });
  assert.deepEqual(loadPatch(s).patch, { 'rail.enabled': true, 'layers.stars': false });
});

test('the wrapper passes through every other method of the settings object', () => {
  const base = { apply: () => ({ applied: [], rejected: [] }), describe: () => 'x' };
  assert.equal(withPersistence(base, fakeStorage()).describe(), 'x');
});

// A managed kiosk policy can make `window.localStorage` a getter that throws
// SecurityError -- main.js guards that PROPERTY access and passes null down
// here rather than ever calling a method on the throwing getter. Everything
// below this line is a regression guard for that null, not for the property
// access itself (which lives in main.js and cannot be unit-tested here).
test('loadPatch tolerates null storage', () => {
  const out = loadPatch(null);
  assert.deepEqual(out.patch, {});
  assert.equal(out.error, null);
});

test('savePatch tolerates null storage and reports it, never throws', () => {
  const out = savePatch(null, { 'rail.enabled': true });
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test('clearPatch tolerates null storage and reports it, never throws', () => {
  const out = clearPatch(null);
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test('withPersistence tolerates null storage: the executor still runs and returns its result', () => {
  const base = { apply: (p) => ({ applied: Object.keys(p), rejected: [] }) };
  const out = withPersistence(base, null).apply({ 'rail.enabled': true });
  assert.deepEqual(out, { applied: ['rail.enabled'], rejected: [] });
});
