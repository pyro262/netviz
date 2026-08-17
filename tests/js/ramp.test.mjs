// ramp.js is three-free by design (see the module's own header comment and
// CLAUDE.md's node --check note) so it can be exercised directly under
// `node --test` in a repo with no node_modules. palette.js has its own test
// file (palette.test.mjs) now that it resolves 'three' by relative path
// instead of the bare specifier -- see that file for why. Keep this one free
// of it anyway: ramp.js's own math needs no THREE.Color to verify.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RAMPS, RAMP_IDS, rampHexAt, setActiveRamp, activeRampStops } from
  '../../netviz/static/js/ramp.js';

const PLASMA_SHIPPED = [
  '#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
  '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921',
];

// setActiveRamp/activeRampStops carry module-level state. Reset it before and
// after every test so a thrown assertion mid-test cannot leak the active ramp
// into the next one -- the prior version restored state with a trailing line
// inside each test, which skips on failure.
beforeEach(() => setActiveRamp('plasma'));
afterEach(() => setActiveRamp('plasma'));

test('plasma is byte-identical to what shipped', () => {
  assert.deepEqual(RAMPS.plasma, PLASMA_SHIPPED);
});

test('every ramp has ten parseable stops', () => {
  assert.deepEqual(RAMP_IDS, ['plasma', 'viridis', 'magma', 'inferno', 'cividis']);
  for (const id of RAMP_IDS) {
    assert.equal(RAMPS[id].length, 10, `${id} stop count`);
    for (const hex of RAMPS[id]) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `${id} stop ${hex}`);
    }
  }
});

test('rampHexAt(0.30) on plasma is #9112a1', () => {
  // Not #8f10a1. three.js r152+ enables ColorManagement, so Color('#hex')
  // stores LINEAR values and lerp() interpolates there, not in sRGB.
  // #8f10a1 is what you get interpolating in sRGB integer space directly --
  // it looks plausible and is wrong. Verified against real three.js, not a
  // mock (see task-1-report.md).
  assert.equal(rampHexAt(0.30, RAMPS.plasma), '#9112a1');
});

test('rampHexAt clamps out-of-range t to the ends', () => {
  assert.equal(rampHexAt(-5, RAMPS.plasma), '#0d0887');
  assert.equal(rampHexAt(99, RAMPS.plasma), '#f0f921');
});

test('rampHexAt is pure: repeatable and does not mutate its stops arg', () => {
  const stops = RAMPS.plasma.slice();
  const before = stops.slice();
  const a = rampHexAt(0.42, stops);
  const b = rampHexAt(0.42, stops);
  assert.equal(a, b);
  assert.deepEqual(stops, before);
});

test('setActiveRamp switches what activeRampStops returns', () => {
  setActiveRamp('plasma');
  assert.equal(activeRampStops()[0], '#0d0887');
  setActiveRamp('viridis');
  assert.equal(activeRampStops()[0], '#440154');
});

test('setActiveRamp accepts a raw stop list for the custom ramp', () => {
  const custom = Array(10).fill('#112233');
  setActiveRamp(custom);
  assert.equal(rampHexAt(0.5, activeRampStops()), '#112233');
  assert.deepEqual(activeRampStops(), custom);
});

test('setActiveRamp rejects a too-short stop list', () => {
  setActiveRamp('plasma');
  setActiveRamp(['#ffffff']);
  assert.deepEqual(activeRampStops(), RAMPS.plasma);
});
