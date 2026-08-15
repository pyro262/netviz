import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS, tunerRows, stepFor, isRandomized, randomizeScope, clearsArcs,
} from '../../netviz/static/js/tuner.js';
import { entry, defaultOf } from '../../netviz/static/js/settings.js';
import { ARC_REBUILD_KEYS } from '../../netviz/static/js/apply.js';

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

test('the panel shows 48 rows in six groups', () => {
  const rows = tunerRows();
  assert.equal(rows.length, 48);
  assert.deepEqual([...new Set(rows.map((r) => r.group))],
                   ['appearance', 'clouds', 'lightning', 'arcs', 'arcshape', 'camera']);
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
  // How fast the traveling head runs, which is the one arc field re-read from
  // the spec every frame -- so it applies instantly and STILL fails the rule.
  // Every head is left exactly where it already was; only the rate it advances
  // at changes, so the frame at the instant of the change is identical and the
  // difference accumulates over the seconds after. "Applies live" and "changes
  // the current frame" are two different questions.
  'arcs.flow.speed',
  'arcs.block.speed',
  'arcs.highlight.speed',
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
  assert.equal(tunerRows().length, 48, 'the table was not put back');
});

test('the randomized set is 36 sliders, and the excluded ones are named', () => {
  // A count alone is passed by a swap. The names are what hold the rule: the
  // camera's distance is IN despite living in "Camera pacing" (it is how big
  // the globe is, visible in the first frame), the star ramp is OUT despite
  // living in "Appearance", and an arc's `life` is IN while its `speed` is OUT
  // despite the two sitting side by side in one group.
  const rows = tunerRows();
  const on = rows.filter((r) => r.control === 'slider' && r.randomize);
  const off = rows.filter((r) => r.control === 'slider' && !r.randomize);
  assert.equal(on.length, 36, `randomized ${on.length} sliders`);
  assert.deepEqual(off.map((r) => r.path).sort(), [...RANDOMIZE_EXCLUDED].sort());
  assert.ok(on.some((r) => r.path === 'camera.distance'),
            'camera.distance is a look setting and must be randomized');
  // The pair the arc-shape group turns on, asserted as a pair: `life` is
  // pushed into the arcs already in the air, so the wall empties or fills in
  // the same frame; `speed` leaves every head where it is.
  for (const cls of ['flow', 'block', 'highlight']) {
    assert.ok(on.some((r) => r.path === `arcs.${cls}.life`),
              `arcs.${cls}.life retires live arcs now and must be randomized`);
    assert.ok(off.some((r) => r.path === `arcs.${cls}.speed`),
              `arcs.${cls}.speed changes a rate, not the frame`);
  }
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

// ---------------------------------------------- the scope the panel PRINTS --
//
// The panel states, in visible copy, how many settings Randomize touches and
// marks each of those rows. These hold that claim to the flag, because the
// specific failure ahead is a NEW ROW: more settings are going to be added to
// this panel, and a count that was true when it was typed is the way a display
// starts telling the room something false with nothing failing.

test('isRandomized is the flag AND the control, not either alone', () => {
  // Three readers ask this question -- the randomizer's loop, the row mark and
  // the printed count -- and they ask it through this one function so they
  // cannot answer differently. A flag-only version would mark the color row.
  for (const row of tunerRows()) {
    assert.equal(isRandomized(row), row.control === 'slider' && row.randomize,
                 `${row.path} disagrees with the shipped predicate`);
  }
  assert.equal(isRandomized({ control: 'color', randomize: true }), false);
  assert.equal(isRandomized(null), false);
});

test('randomizeScope partitions every row, and rolled matches the flag', () => {
  const rows = tunerRows();
  const scope = randomizeScope(rows);
  assert.equal(scope.count, rows.filter(isRandomized).length);
  assert.equal(scope.heldCount, rows.length - scope.count);
  // A partition, not two filters that might overlap or drop a row: the copy
  // says "the other N", and that is only true if the two sides are all of them.
  assert.equal(scope.rolled.length + scope.held.length, rows.length);
  assert.deepEqual([...scope.rolled, ...scope.held].map((r) => r.path).sort(),
                   rows.map((r) => r.path).sort());
  // Today's numbers, stated so a change is deliberate rather than unnoticed.
  assert.equal(scope.count, 36);
  assert.equal(scope.heldCount, 12);
});

test('the scope moves with the table rather than being written down', () => {
  // The staleness guard itself: hide a randomizable row and the count must
  // follow it down. A hardcoded 17 passes every test above and fails this one.
  const group = GROUPS.find((g) => g.id === 'arcs');
  const removed = group.rows.pop();
  try {
    assert.equal(randomizeScope().count, 35);
  } finally {
    group.rows.push(removed);
  }
  assert.equal(randomizeScope().count, 36, 'the table was not put back');
});

// ------------------------------------------------- the rows that rebuild --
//
// Three arc fields are baked into a slot's TubeGeometry at spawn, so changing
// one clears the pool and the wall refills over the next few seconds. The
// panel marks those rows, and these hold the mark to the SCHEMA rather than to
// a list -- a warning on a row that does not clear, or a row that clears with
// no warning, are both a display saying something untrue about itself.

test('a row rebuilds exactly when its schema entry says rebuild', () => {
  for (const row of tunerRows()) {
    assert.equal(row.rebuilds, entry(row.path).strategy === 'rebuild', row.path);
    assert.equal(clearsArcs(row), row.rebuilds, row.path);
  }
  assert.equal(clearsArcs(null), false);
  assert.equal(clearsArcs({ rebuilds: 'yes' }), false, 'only a real true counts');
});

test('the rebuilding rows are the three geometry fields on all three classes', () => {
  // Named, not counted, and derived from apply.js's own ARC_REBUILD_KEYS --
  // the list the handler that clears the pool reads. A test that only counted
  // nine would pass a swap, and a fourth list written out here is exactly the
  // drift the derivation exists to prevent.
  const want = [];
  for (const cls of ['flow', 'block', 'highlight']) {
    for (const key of ARC_REBUILD_KEYS) want.push(`arcs.${cls}.${key}`);
  }
  const got = tunerRows().filter(clearsArcs).map((r) => r.path);
  assert.deepEqual(got.sort(), want.sort());
  assert.equal(got.length, 9);
});

test('every rebuilding row on the panel is one Randomize can roll', () => {
  // Not a coincidence and not a requirement of the schema: all three geometry
  // fields change the picture now, so all nine carry both marks. Stated so
  // that if one is ever held back, the pool-clear count in the randomizer's
  // note has to be revisited rather than quietly becoming wrong.
  for (const row of tunerRows()) {
    if (!clearsArcs(row)) continue;
    assert.ok(isRandomized(row), `${row.path} rebuilds but is held back`);
  }
});
