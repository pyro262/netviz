import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, tunerRows, stepFor } from '../../netviz/static/js/tuner.js';
import { entry, defaultOf } from '../../netviz/static/js/settings.js';

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
