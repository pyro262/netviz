import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA, paths, entry, defaultOf, coerce, validate, planApply,
} from '../../netviz/static/js/settings.js';
import { cfg } from '../../netviz/static/js/config.js';

test('every declared path exists in config.js', () => {
  // The schema is a description of config.js, not a second copy of it. A path
  // that resolves to undefined is a typo, and it would surface later as a
  // control whose default is blank.
  const missing = paths().filter((p) => cfg(p, undefined) === undefined);
  assert.deepEqual(missing, [], `paths not in config.js: ${missing.join(', ')}`);
});

test('every entry declares a type, a strategy and help text', () => {
  const TYPES = ['bool', 'int', 'number', 'enum', 'color', 'list'];
  const STRATS = ['uniform', 'rebuild', 'relayout'];
  for (const p of paths()) {
    const e = entry(p);
    assert.ok(TYPES.includes(e.type), `${p}: bad type ${e.type}`);
    assert.ok(STRATS.includes(e.strategy), `${p}: bad strategy ${e.strategy}`);
    assert.ok(typeof e.help === 'string' && e.help.length > 10,
      `${p}: help text is missing or too short to be help`);
  }
});

test('every number declares both bounds', () => {
  // An unbounded number is how a display becomes unreadable: see spec 6.2.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'number' && e.type !== 'int') continue;
    assert.equal(typeof e.min, 'number', `${p}: no min`);
    assert.equal(typeof e.max, 'number', `${p}: no max`);
    assert.ok(e.min < e.max, `${p}: min ${e.min} is not below max ${e.max}`);
  }
});

test('the shipped default is inside its own bounds', () => {
  // Catches a bound written from memory rather than from the file.
  for (const p of paths()) {
    const e = entry(p);
    if (e.type !== 'number' && e.type !== 'int') continue;
    const d = defaultOf(p);
    assert.ok(d >= e.min && d <= e.max,
      `${p}: shipped default ${d} is outside ${e.min}..${e.max}`);
  }
});

test('defaultOf reads config.js rather than a copy', () => {
  assert.equal(defaultOf('traffic.flowsPerSecond'), cfg('traffic.flowsPerSecond'));
  assert.equal(defaultOf('rail.enabled'), cfg('rail.enabled'));
});

test('coerce clamps a number into its bounds instead of refusing it', () => {
  // A slider dragged to the end and a hand-edited file are the same input here.
  // Clamping keeps a working display; refusing leaves the old value with no
  // feedback, which reads as a broken control.
  assert.deepEqual(coerce('traffic.flowsPerSecond', 500), { ok: true, value: 60 });
  assert.deepEqual(coerce('traffic.flowsPerSecond', 0), { ok: true, value: 1 });
  assert.deepEqual(coerce('traffic.flowsPerSecond', 20), { ok: true, value: 20 });
});

test('coerce rounds an int and keeps a number', () => {
  assert.deepEqual(coerce('traffic.flowsPerSecond', 12.7), { ok: true, value: 13 });
  assert.deepEqual(coerce('arcs.bodyOpacity', 0.235), { ok: true, value: 0.235 });
});

test('coerce rejects the wrong shape rather than guessing', () => {
  assert.equal(coerce('traffic.flowsPerSecond', 'lots').ok, false);
  assert.equal(coerce('traffic.flowsPerSecond', NaN).ok, false);
  assert.equal(coerce('rail.enabled', 'yes').ok, false);
  assert.equal(coerce('appearance.background', 'not-a-colour').ok, false);
  assert.equal(coerce('nonsense.path', 1).ok, false);
});

test('coerce accepts a colour in the form the renderer uses', () => {
  assert.deepEqual(coerce('appearance.background', '#0b0916'),
                   { ok: true, value: '#0b0916' });
  assert.deepEqual(coerce('appearance.background', '#FFF'),
                   { ok: true, value: '#FFF' });
});

test('validate splits a mixed patch and never throws', () => {
  const out = validate({
    'traffic.flowsPerSecond': 999,      // clamped
    'rail.enabled': true,               // fine
    'rail.enabled.deeper': true,        // unknown
    'arcs.bodyOpacity': 'thick',        // wrong type
  });
  assert.equal(out.accepted['traffic.flowsPerSecond'], 60);
  assert.equal(out.accepted['rail.enabled'], true);
  assert.equal(Object.keys(out.accepted).length, 2);
  assert.deepEqual(out.rejected.map((r) => r.path).sort(),
                   ['arcs.bodyOpacity', 'rail.enabled.deeper']);
  for (const r of out.rejected) assert.ok(r.why.length > 0, 'a rejection needs a reason');
});

test('planApply groups a patch by strategy', () => {
  const plan = planApply({
    'arcs.bodyOpacity': 0.2,        // uniform
    'appearance.background': '#000',// uniform
    'arcs.flow.tube': 0.004,        // rebuild
    'rail.enabled': true,           // relayout
  });
  assert.deepEqual(plan.uniform.sort(), ['appearance.background', 'arcs.bodyOpacity']);
  assert.deepEqual(plan.rebuild, ['arcs.flow.tube']);
  assert.equal(plan.relayout, true);
});

test('planApply collapses several relayouts into one', () => {
  // Toggling three things that each need a resize must cost one resize, not
  // three: a resize rebuilds the composer targets and is the expensive move.
  const plan = planApply({ 'rail.enabled': true, 'arcs.bodyOpacity': 0.2 });
  assert.equal(plan.relayout, true);
  assert.equal(typeof plan.relayout, 'boolean');
});

test('planApply ignores paths it does not know', () => {
  const plan = planApply({ 'made.up.path': 1, 'arcs.bodyOpacity': 0.2 });
  assert.deepEqual(plan.uniform, ['arcs.bodyOpacity']);
  assert.deepEqual(plan.rebuild, []);
  assert.equal(plan.relayout, false);
});
