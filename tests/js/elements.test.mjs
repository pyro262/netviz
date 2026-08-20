import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENT_T, ELEMENT_LITERAL, AUTO, resolveColor, isAuto } from
  '../../netviz/static/js/elements.js';
// ramp.js, NOT palette.js -- palette.js imports three and cannot be loaded here.
import { setActiveRamp, rampHexAt, activeRampStops } from
  '../../netviz/static/js/ramp.js';

test('the table carries every ramp-derived element with its shipped t', () => {
  assert.deepEqual(ELEMENT_T, {
    coastline: 0.42,
    bordersWorld: 0.24,
    admin1: 0.26,
    bordersWatched: 0.86,
    countryFlash: 0.86,
    cities: 0.72,
    atmosphere: 0.20,
    rippleFlow: 0.34,
    rippleBlock: 0.86,
    railWordmark: 1.00,
    railClock: 0.89,
    railPanelTitle: 0.67,
    railBig: 0.89,
    railLabel: 0.44,
    railValue: 0.89,
    railAlarm: 0.60,
    railBars: 0.67,
  });
});

test('the literal elements are not on the ramp', () => {
  assert.deepEqual(ELEMENT_LITERAL, {
    rippleHighlight: '#22d3ee',
    auroraLow: '#38ffa8',
    auroraHigh: '#c56cff',
  });
});

test('auto resolves through the active ramp', () => {
  setActiveRamp('plasma');
  assert.equal(resolveColor('coastline', AUTO),
               rampHexAt(0.42, activeRampStops()));
  setActiveRamp('viridis');
  assert.equal(resolveColor('coastline', AUTO),
               rampHexAt(0.42, activeRampStops()));
});

test('an explicit hex is held across a theme change', () => {
  setActiveRamp('plasma');
  const before = resolveColor('coastline', '#ff0088');
  setActiveRamp('inferno');
  assert.equal(resolveColor('coastline', '#ff0088'), before);
  assert.equal(before, '#ff0088');
});

test('a literal element falls back to its shipped hex when auto', () => {
  // auroraLow has no t -- there is no ramp position that means "oxygen green".
  assert.equal(resolveColor('auroraLow', AUTO), '#38ffa8');
});

test('active-ramp state does not leak between tests', (t) => {
  // Restore in a hook, never as a trailing line: a failed assertion skips the
  // trailing line and leaks the ramp into every later test.
  t.after(() => setActiveRamp('plasma'));
  setActiveRamp('magma');
  assert.notEqual(resolveColor('coastline', AUTO), resolveColor('cities', AUTO));
});

test('isAuto is exact, not truthy', () => {
  assert.equal(isAuto('auto'), true);
  assert.equal(isAuto('#auto0'), false);
  assert.equal(isAuto(''), false);
  assert.equal(isAuto(undefined), false);
});

// ---------------------------------------------------------------------------
// The rail's text joins the catalogue (0.7.0).

import { entry, paths } from '../../netviz/static/js/settings.js';
import { RAMPS } from '../../netviz/static/js/ramp.js';

const RAIL_KEYS = ['railWordmark', 'railClock', 'railPanelTitle', 'railBig',
                   'railLabel', 'railValue', 'railAlarm', 'railBars'];

test('the catalogue is twenty entries: seventeen ramp, three literal', () => {
  assert.equal(Object.keys(ELEMENT_T).length + Object.keys(ELEMENT_LITERAL).length, 20);
  for (const k of RAIL_KEYS) assert.ok(k in ELEMENT_T, `${k} is on the ramp`);
});

test('every catalogue key has a schema path and vice versa', () => {
  const keys = [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)];
  for (const k of keys) assert.ok(entry(`appearance.colors.${k}`), k);
  const declared = paths().filter((p) => p.startsWith('appearance.colors.'));
  assert.equal(declared.length, keys.length);
});

test('railAlarm stays distinct from railValue on ALL FIVE presets', () => {
  // The judgment a test CAN hold: two ramp samples far enough apart that the
  // alarm never lands in the value color's neighborhood. "Still reads as an
  // alarm" is a wall decision and is not claimed here.
  //
  // 0.60 is the value whose WORST separation across the five presets clears
  // this threshold -- cividis at 102. 0.65 does not (cividis, 88), and today's
  // literal #fb9f3a is t~0.78, only 0.11 from railValue.
  const hex2 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const dist = (a, b) => Math.hypot(...hex2(a).map((v, i) => v - hex2(b)[i]));
  for (const [id, stops] of Object.entries(RAMPS)) {
    const d = dist(rampHexAt(ELEMENT_T.railAlarm, stops),
                   rampHexAt(ELEMENT_T.railValue, stops));
    assert.ok(d >= 90, `${id}: railAlarm and railValue are ${d.toFixed(0)} apart, want >= 90`);
  }
});
