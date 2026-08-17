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
