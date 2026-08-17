import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RAMPS, RAMP_IDS, rampAt, setActiveRamp, activeRampStops } from
  '../../netviz/static/js/palette.js';

const PLASMA_SHIPPED = [
  '#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
  '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921',
];

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

test('rampAt(0.30) on plasma is #8f10a1', () => {
  // The value the old cap derivation got wrong: it claimed #3b0f70.
  // Asserted directly so the corrected derivation cannot rot back.
  const c = rampAt(0.30, 'plasma');
  assert.equal(c.getHexString(), '8f10a1');
});

test('rampAt clamps out-of-range t to the ends', () => {
  assert.equal(rampAt(-5, 'plasma').getHexString(), '0d0887');
  assert.equal(rampAt(99, 'plasma').getHexString(), 'f0f921');
});

test('setActiveRamp switches what rampAt returns with no id', () => {
  setActiveRamp('plasma');
  assert.equal(rampAt(0).getHexString(), '0d0887');
  setActiveRamp('viridis');
  assert.equal(rampAt(0).getHexString(), '440154');
  setActiveRamp('plasma');            // leave the module as we found it
});

test('setActiveRamp accepts a raw stop list for the custom ramp', () => {
  const custom = Array(10).fill('#112233');
  setActiveRamp(custom);
  assert.equal(rampAt(0.5).getHexString(), '112233');
  assert.deepEqual(activeRampStops(), custom);
  setActiveRamp('plasma');
});
