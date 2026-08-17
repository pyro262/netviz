import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomizeRamp, chaosColors, MIN_ELEMENT_LUMINANCE } from
  '../../netviz/static/js/randomize_color.js';
import { relativeLuminance, maxBackgroundLuminance } from '../../netviz/static/js/settings.js';
import { ELEMENT_T, ELEMENT_LITERAL } from '../../netviz/static/js/elements.js';
import { setActiveRamp } from '../../netviz/static/js/ramp.js';

/** Deterministic source, so a one-in-a-thousand bad roll is a test failure and
 *  not something that reaches the wall. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('a random ramp has ten valid stops with monotonic lightness', () => {
  for (let seed = 0; seed < 2000; seed += 1) {
    const stops = randomizeRamp(seeded(seed));
    assert.equal(stops.length, 10, `seed ${seed}`);
    let last = -1;
    for (const hex of stops) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `seed ${seed} stop ${hex}`);
      const L = relativeLuminance(hex);
      assert.ok(L >= last, `seed ${seed}: lightness went down at ${hex}`);
      last = L;
    }
  }
});

test('chaos rolls every element and never goes under the floor', () => {
  const keys = [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)];
  for (let seed = 0; seed < 2000; seed += 1) {
    const out = chaosColors(seeded(seed));
    assert.deepEqual(Object.keys(out).sort(), keys.sort(), `seed ${seed}`);
    for (const [k, hex] of Object.entries(out)) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `seed ${seed} ${k}`);
      assert.ok(relativeLuminance(hex) >= MIN_ELEMENT_LUMINANCE,
                `seed ${seed} ${k} = ${hex} is effectively invisible`);
    }
  }
});

test('chaos never touches the sky', () => {
  const out = chaosColors(seeded(7));
  assert.equal(out.background, undefined);
  assert.equal(out['appearance.background'], undefined);
});

test('a random ramp always leaves the shipped sky legal under its own cap', () => {
  // The "legal cap" property the spec lists for randomizeRamp: whatever ramp
  // comes out, the shipped ground (#0b0916) must still sit under the cap that
  // ramp derives -- apply.js sets the custom sky by direct assignment,
  // bypassing coerce, so nothing today would refuse or even report a ramp
  // that broke this. Measured over 200k seeds: it holds, but only by 5.5%
  // (worst cap 0.00342 against the shipped sky's 0.00324), so this is worth
  // holding down rather than trusting by eye.
  const floor = relativeLuminance('#0b0916');
  try {
    for (let seed = 0; seed < 2000; seed += 1) {
      const stops = randomizeRamp(seeded(seed));
      setActiveRamp(stops);
      assert.ok(maxBackgroundLuminance() > floor,
                 `seed ${seed}: cap ${maxBackgroundLuminance()} <= shipped sky ${floor}`);
    }
  } finally {
    setActiveRamp('plasma');
  }
});
