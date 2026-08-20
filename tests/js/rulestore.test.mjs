import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, loadPatch, savePatch, clearPatch, withPersistence,
  serialiseRules, parseImport, exportFilename, loadConverted }
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
  const patch = { 'arcs.custom': [{ match: 'DE', color: '#ff8800' }], 'rail.enabled': true };
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

test('clear keeps the paths it is told to keep', () => {
  // "Reset to netviz defaults" resets the DISPLAY, not the operator's work.
  // The saved patch is one blob holding every persisted setting, so keeping
  // the rules means writing them back -- deleting the key would take them
  // with it, which is the behaviour this argument exists to prevent.
  const s = fakeStorage({
    [KEY]: JSON.stringify({
      'rail.enabled': true,
      'layers.stars': false,
      'arcs.custom': [{ match: 'DE', color: '#ff8800' }],
    }),
  });
  assert.equal(clearPatch(s, ['arcs.custom']).ok, true);
  assert.deepEqual(loadPatch(s).patch, { 'arcs.custom': [{ match: 'DE', color: '#ff8800' }] });
});

test('clear with nothing left to keep removes the key outright', () => {
  // Not an empty object: an empty patch and no patch mean the same thing to
  // every reader, and leaving `{}` behind is a row in someone's storage
  // inspector that says the display was configured when it was not.
  const s = fakeStorage({ [KEY]: '{"rail.enabled":true}' });
  assert.equal(clearPatch(s, ['arcs.custom']).ok, true);
  assert.equal(s.getItem(KEY), null);
});

test('clear keeping a path that was never set does not invent it', () => {
  const s = fakeStorage({ [KEY]: '{"rail.enabled":true,"layers.stars":false}' });
  clearPatch(s, ['arcs.custom']);
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
  const base = { apply: () => ({ applied: [], rejected: [{ path: 'arcs.custom', why: 'bad' }] }) };
  withPersistence(base, s).apply({ 'arcs.custom': [{ match: 'nonsense' }] });
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

test('an exported list imports back identically', () => {
  const list = [{ match: '10.20.50.0/24', color: '#22d3ee', name: 'storj',
                  end: 'either', enabled: true }];
  const out = parseImport(serialiseRules(list));
  assert.equal(out.error, null);
  assert.deepEqual(out.rules, list);
});

test('an import is ALL-or-nothing, unlike a live edit', () => {
  // A live edit is a keystroke; an import is one deliberate act, and half of
  // one is confusing. Every bad row is named, not just the first.
  const out = parseImport(JSON.stringify([
    { match: '10.20.50.0/24', color: '#22d3ee' },
    { match: 'nonsense', color: '#fff' },
    { match: 'DE', color: 'blue' },
  ]));
  assert.equal(out.rules, undefined);
  assert.match(out.error, /entry 2/);
  assert.match(out.error, /entry 3/);
});

test('an import refuses what is not a list of rules', () => {
  assert.ok(parseImport('{"match":"DE"}').error);
  assert.ok(parseImport('not json').error);
  assert.ok(parseImport('').error);
});

test('an empty exported list is a legitimate import', () => {
  // "This display has no rules" is a real thing to back up and restore.
  const out = parseImport(serialiseRules([]));
  assert.equal(out.error, null);
  assert.deepEqual(out.rules, []);
});

test('the export filename carries the date', () => {
  assert.equal(exportFilename(new Date(Date.UTC(2026, 7, 11))),
               'netviz-rules-2026-08-11.json');
});

// ---------------------------------------------------------------------------
// loadConverted -- 0.7.0's schema rename, read at boot and written by nobody.

const CONV_RULES = [{ match: '203.0.113.0/24', end: 'either', color: '#00ff88',
                      name: 'docs net', enabled: true }];
const peek = (s) => JSON.parse(s.data[KEY]);

test('loadConverted reads an old blob as the new path', () => {
  const s = fakeStorage({ [KEY]: JSON.stringify({ 'arcs.rules': CONV_RULES }) });
  const out = loadConverted(s);
  assert.deepEqual(out.patch['arcs.custom'], CONV_RULES);
  assert.equal(out.pending.length, 1);
});

test('loadConverted writes nothing -- storage still holds the old name', () => {
  const s = fakeStorage({ [KEY]: JSON.stringify({ 'arcs.rules': CONV_RULES }) });
  loadConverted(s);
  assert.deepEqual(Object.keys(peek(s)), ['arcs.rules']);
});

test('loadPatch stays raw, so savePatch cannot convert by accident', () => {
  const s = fakeStorage({ [KEY]: JSON.stringify({ 'arcs.rules': CONV_RULES }) });
  assert.deepEqual(loadPatch(s).patch, { 'arcs.rules': CONV_RULES });
  savePatch(s, { 'rail.enabled': true });
  assert.deepEqual(Object.keys(peek(s)).sort(), ['arcs.rules', 'rail.enabled']);
});

test('a reset keeps the custom arcs under EITHER name', () => {
  const s = fakeStorage({ [KEY]: JSON.stringify({ 'arcs.rules': CONV_RULES,
                                                  'rail.enabled': true }) });
  clearPatch(s, ['arcs.custom', 'arcs.rules']);
  assert.deepEqual(peek(s), { 'arcs.rules': CONV_RULES });
});

test('an exported file in the old format imports and says it was converted', () => {
  const out = parseImport(JSON.stringify({ version: 1, rules: CONV_RULES }));
  assert.deepEqual(out.rules, CONV_RULES);
  assert.equal(out.converted, true);
});

test('a plain list is still the current format and is not reported as converted', () => {
  const out = parseImport(JSON.stringify(CONV_RULES));
  assert.deepEqual(out.rules, CONV_RULES);
  assert.equal(out.converted, false);
});
