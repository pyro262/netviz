import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomizeRamp, chaosColors, MIN_ELEMENT_LUMINANCE } from
  '../../netviz/static/js/randomize_color.js';
import { relativeLuminance } from '../../netviz/static/js/settings.js';
import { ELEMENT_T, ELEMENT_LITERAL } from '../../netviz/static/js/elements.js';

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
