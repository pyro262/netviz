import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dirtyPatch, revertPatch, keepQuestion, revertQuestion, closeQuestion,
} from '../../netviz/static/js/settings_panel.js';
import { settingLabel } from '../../netviz/static/js/settings.js';

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

// ------------------------------------------------- the three confirmations --
//
// Keep, Revert and Close each end the pending work in a way clicking again does
// not undo, so each asks first. The words are what is worth testing -- the
// dialog itself is confirm.js's, already proved, and the DOM half of the panel
// is proved by tools/verify_tuner.py against a real browser. What is proved
// here is that the question is built from what is ACTUALLY pending and that it
// honors confirm.js's contract.

const QUESTIONS = [
  ['keep', keepQuestion],
  ['revert', revertQuestion],
  ['close', closeQuestion],
];
const ONE = ['layers.stars'];
const THREE = ['layers.stars', 'arcs.bodyOpacity', 'appearance.bloom.strength'];

const allText = (q) => [q.title, q.lead, ...(q.will || []), ...(q.wont || []),
                        q.note || ''].join(' ');

for (const [name, build] of QUESTIONS) {
  test(`the ${name} question names every pending setting, in words`, () => {
    const q = build(THREE);
    const text = allText(q);
    for (const path of THREE) {
      const label = settingLabel(path);
      // The LABEL, not the raw path. `layers.stars` on a wall somebody else
      // walks up to is jargon; "the stars layer" is the same discipline
      // main.js's reset dialog follows, and settingLabel is the one place that
      // translation lives.
      assert.ok(text.includes(label),
                `${name}: no mention of ${label} (for ${path}) in:\n${text}`);
      assert.ok(!text.includes(path),
                `${name}: names the raw path ${path} rather than its label`);
    }
  });

  test(`the ${name} question says what it will NOT do`, () => {
    // The half confirm.js exists to enforce: a warning that only lists
    // consequences reads as "something bad is happening" and gets clicked
    // through. Deleting `wont` from any of the three must fail here.
    const q = build(THREE);
    assert.ok(Array.isArray(q.wont) && q.wont.length > 0,
              `${name} carries no 'wont'`);
    for (const line of q.wont) assert.ok(line.trim().length > 0);
  });

  test(`the ${name} question counts and pluralizes for one and for several`, () => {
    const one = allText(build(ONE));
    const many = allText(build(THREE));
    assert.ok(/\b1 (setting|change)\b/.test(one),
              `${name} does not say "1 setting"/"1 change": ${one}`);
    assert.ok(!/\b1 (settings|changes)\b/.test(one),
              `${name} pluralizes a single item: ${one}`);
    assert.ok(/\b3 (settings|changes)\b/.test(many),
              `${name} does not say "3 settings"/"3 changes": ${many}`);
  });

  test(`the ${name} question labels both buttons`, () => {
    const q = build(THREE);
    assert.ok(q.confirmLabel && q.cancelLabel, `${name} leaves a button unlabeled`);
  });
}

test('the close question is only ever built when something is pending', () => {
  // Null, not an acknowledgement: closing an untouched panel has nothing to
  // confirm, and a one-button modal in front of every ordinary close would
  // teach exactly what confirm.js's empty-`will` rule exists to prevent. The
  // panel reads this null and closes on the one click.
  assert.equal(closeQuestion([]), null);
  assert.equal(closeQuestion(), null);
  assert.ok(closeQuestion(ONE));
});

test('keep and revert degrade to an acknowledgement rather than a false yes/no', () => {
  // Both buttons are disabled with nothing pending, so this is the degenerate
  // case -- but an empty `will` is what confirm.js reads to drop the Yes
  // button, so the words must not promise an action either way.
  for (const build of [keepQuestion, revertQuestion]) {
    const q = build([]);
    assert.deepEqual(q.will, []);
    assert.ok(q.note, 'an acknowledgement with nothing to say is not one');
  }
});

test('the keep question says where the settings are written, and where they are not', () => {
  const text = allText(keepQuestion(ONE));
  assert.match(text, /browser/i);
  assert.match(text, /collector/i);
  assert.match(text, /other display/i);
  assert.match(text, /color rules/i);
});

test('the revert question says what the wall goes back to, and what survives', () => {
  const q = revertQuestion(ONE);
  assert.match(allText(q).toLowerCase(), /whichever is later/);
  assert.match(q.wont.join(' '), /already kept/i);
});

test('the close question points at Keep as the way not to lose the work', () => {
  const q = closeQuestion(ONE);
  assert.match(q.note, /Keep/);
  assert.match(q.wont.join(' '), /already kept/i);
});
