import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, tunerRows, stepFor } from '../../netviz/static/js/tuner.js';
import { entry, defaultOf } from '../../netviz/static/js/settings.js';

/** The control a path will be drawn with, read the way tuner.js reads it --
 *  from the schema type -- so a test over raw GROUPS rows does not need a
 *  second copy of the mapping. */
const CONTROL_OF = (path) =>
  ({ number: 'slider', int: 'slider', color: 'color', bool: 'checkbox' })[entry(path).type];

test('every row names a path the schema actually declares', () => {
  for (const row of tunerRows()) {
    assert.ok(entry(row.path), `${row.path} is not in the schema`);
  }
});

test('the panel shows 24 rows in three groups', () => {
  const rows = tunerRows();
  assert.equal(rows.length, 24);
  assert.deepEqual([...new Set(rows.map((r) => r.group))],
                   ['appearance', 'arcs', 'camera']);
});

test('no path appears twice, and no label repeats inside a group', () => {
  const rows = tunerRows();
  assert.equal(new Set(rows.map((r) => r.path)).size, rows.length);
  for (const g of GROUPS) {
    const labels = g.rows.map((r) => r.label);
    assert.equal(new Set(labels).size, labels.length, `${g.id} repeats a label`);
  }
});

test('bounds and step come from the schema, never from here', () => {
  for (const row of tunerRows()) {
    if (row.control !== 'slider') continue;
    const e = entry(row.path);
    assert.equal(row.min, e.min);
    assert.equal(row.max, e.max);
    assert.ok(row.step > 0);
    // A step has to divide the range into something a person can land on.
    assert.ok((e.max - e.min) / row.step >= 20, `${row.path} step too coarse`);
  }
});

test('an int steps by one and a number does not', () => {
  assert.equal(stepFor({ type: 'int', min: 1, max: 60 }), 1);
  assert.ok(stepFor({ type: 'number', min: 0, max: 1 }) < 1);
});

test('the control matches the declared type', () => {
  const want = { number: 'slider', int: 'slider', color: 'color', bool: 'checkbox' };
  for (const row of tunerRows()) {
    assert.equal(row.control, want[entry(row.path).type], row.path);
  }
});

test('every row carries the schema help text', () => {
  for (const row of tunerRows()) {
    assert.equal(row.help, entry(row.path).help);
    assert.ok(row.help.length > 20, `${row.path} has no usable help`);
  }
});

test('every row has a shipped value to open on', () => {
  // defaultOf reads config.js. A row whose path config.js does not carry
  // would open on `undefined` and write NaN into the wall on first drag.
  for (const row of tunerRows()) {
    assert.notEqual(defaultOf(row.path), undefined, row.path);
  }
});

test('the shipped value sits inside the slider it will be drawn on', () => {
  for (const row of tunerRows()) {
    if (row.control !== 'slider') continue;
    const v = defaultOf(row.path);
    assert.ok(v >= row.min && v <= row.max, `${row.path} ships outside its bounds`);
  }
});

// ---------------------------------------------------------- the look flag --
//
// `randomize` says a row changes what the display looks like RIGHT NOW, which
// is what the Randomize button is allowed to touch. It is a judgement per row
// and these tests hold the judgement, not the mechanism: the set is asserted
// BY NAME, so moving a row between the two sides fails loudly instead of
// keeping the total right by accident.

const RANDOMIZE_EXCLUDED = [
  // Timing, not picture: how fast star brightness crosses dawn and dusk. The
  // current frame is identical unless the display happens to be mid-ramp --
  // and it sits in "Appearance", which is exactly why a group check cannot
  // stand in for the flag.
  'appearance.starRampMinutes',
  // The camera's MOTION, not its picture. Randomizing these makes the wall
  // behave strangely for the next few minutes, which is much harder to notice
  // you have done than a color that just changed.
  'camera.walk.cycleSeconds',
  'camera.walk.holdSeconds',
  'camera.walk.spanDegrees',
  'camera.walk.rampFloor',
  'camera.walk.degreesPerSecond',
];

test('every slider declares randomize explicitly, never by default', () => {
  // Same shape as the schema's "every number declares both bounds". A new row
  // that forgets the flag must not silently join the randomizer, and must not
  // silently drop out of it either -- both are decisions nobody made.
  for (const group of GROUPS) {
    for (const row of group.rows) {
      if (CONTROL_OF(row.path) !== 'slider') continue;
      assert.equal(typeof row.randomize, 'boolean',
                   `${row.path} does not declare randomize`);
    }
  }
});

test('tunerRows refuses a slider with no randomize flag', () => {
  // The runtime half of the rule above: the throw is what stops an undeclared
  // row from being drawn at all, rather than being quietly excluded.
  const good = GROUPS[0].rows[0];
  const saved = good.randomize;
  delete good.randomize;
  try {
    assert.throws(() => tunerRows(), /does not declare randomize/);
  } finally {
    good.randomize = saved;
  }
  assert.equal(tunerRows().length, 24, 'the table was not put back');
});

test('the randomized set is 17 sliders, and the excluded six are these six', () => {
  // A count alone is passed by a swap. The names are what hold the rule: the
  // camera's distance is IN despite living in "Camera pacing" (it is how big
  // the globe is, visible in the first frame), and the star ramp is OUT
  // despite living in "Appearance".
  const rows = tunerRows();
  const on = rows.filter((r) => r.control === 'slider' && r.randomize);
  const off = rows.filter((r) => r.control === 'slider' && !r.randomize);
  assert.equal(on.length, 17, `randomized ${on.length} sliders`);
  assert.deepEqual(off.map((r) => r.path).sort(), [...RANDOMIZE_EXCLUDED].sort());
  assert.ok(on.some((r) => r.path === 'camera.distance'),
            'camera.distance is a look setting and must be randomized');
  assert.equal(on.length + off.length, rows.filter((r) => r.control === 'slider').length);
});

test('a non-slider row is never in the randomized set', () => {
  // The color row's luminance cap refuses rather than clamps, so it is out on
  // two counts. `randomize` is reported for every row, so the flag alone must
  // not be enough to make one eligible.
  for (const row of tunerRows()) {
    if (row.control === 'slider') continue;
    assert.equal(row.randomize, false, `${row.path} claims to be randomizable`);
  }
});
