import test from 'node:test';
import assert from 'node:assert/strict';
import { dirtyPatch, revertPatch } from '../../netviz/static/js/settings_panel.js';

test('a keep writes only the rows that were touched', () => {
  const snapshot = new Map([['a', 1], ['b', 2], ['c', 3]]);
  const current = new Map([['a', 9], ['b', 2], ['c', 7]]);
  assert.deepEqual(dirtyPatch(snapshot, current, new Set(['a', 'c'])),
                   { a: 9, c: 7 });
});

test('a touched row that was put back is still written', () => {
  // The branch's headline contract: touched, NOT changed. Somebody dragged
  // this row, looked at the wall and put it back -- that is a decision about
  // this display and it is kept, so the stored value stops tracking a later
  // config.js change to the same path. Adding "skip it if the value equals
  // the snapshot" is the plausible optimization this test exists to refuse.
  assert.deepEqual(dirtyPatch(new Map([['a', 1]]), new Map([['a', 1]]),
                              new Set(['a'])),
                   { a: 1 });
});

test('an untouched row is never written, even if its value moved elsewhere', () => {
  // Something else on the display changed `b` while the panel was open --
  // the menu, a stored patch, the collector. The panel did not touch it, so
  // Keep has no business freezing it into this display's localStorage.
  const snapshot = new Map([['a', 1], ['b', 2]]);
  const current = new Map([['a', 1], ['b', 5]]);
  assert.deepEqual(dirtyPatch(snapshot, current, new Set()), {});
});

test('a revert restores the snapshot for the touched rows only', () => {
  const snapshot = new Map([['a', 1], ['b', 2]]);
  assert.deepEqual(revertPatch(snapshot, new Set(['b'])), { b: 2 });
});

test('reverting nothing is an empty patch, not a full re-apply', () => {
  const snapshot = new Map([['a', 1], ['b', 2]]);
  assert.deepEqual(revertPatch(snapshot, new Set()), {});
});

test('a path with no snapshot entry is skipped rather than written undefined', () => {
  // Belt and braces: a dirty mark with no snapshot behind it would otherwise
  // apply `undefined` and coerce would report "not a finite number" on a
  // control the person never touched.
  assert.deepEqual(revertPatch(new Map(), new Set(['a'])), {});
  assert.deepEqual(dirtyPatch(new Map(), new Map([['a', 1]]), new Set(['a'])), {});
});

test('a persist: false path is applied live but never kept', () => {
  // Keep calls savePatch() directly rather than going through
  // withPersistence, so the schema's `persist: false` has to be honored here
  // too -- otherwise a collector-owned row that someone drags and Keeps is
  // frozen into this display's localStorage at the merged value it happened
  // to hold, and the display silently ignores every later change the
  // collector makes. `traffic.extraResolvers` is the path that declares it.
  const snapshot = new Map([['traffic.extraResolvers', []],
                            ['layers.stars', true]]);
  const current = new Map([['traffic.extraResolvers', ['203.0.113.53']],
                           ['layers.stars', false]]);
  const patch = dirtyPatch(snapshot, current,
                           new Set(['traffic.extraResolvers', 'layers.stars']));
  // Both halves, because either alone is passed by a bug that dropped
  // everything: the excluded path is absent AND the ordinary one is present.
  assert.deepEqual(patch, { 'layers.stars': false });
});
