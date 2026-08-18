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

// ---------------------------------------------------------------- chaos v2 --
// Chaos was "not as chaotic as envisioned" on the wall: every element rolled
// lightness 0.45-0.85 and saturation 0.55-1.0, so twelve mid-bright colors of
// similar weight, and it touched no arc, no surface tint and no atmosphere --
// leaving the brightest, most-moving thing on the display untouched.

import {
  minLightnessFor, arcLuminanceFloor, chaosPatch, CHAOS_PATHS,
  MIN_TINT_LIGHTNESS, MAX_TINT_SATURATION, ATMOSPHERE_CHAOS, hslToHex,
} from '../../netviz/static/js/randomize_color.js';

test('the lightness floor is per hue, not one conservative number', () => {
  // Luminance is hue-weighted (0.7152 green, 0.0722 blue), so a yellow clears
  // the floor far darker than a blue does. The old fixed 0.45 was the blue
  // answer applied to every hue, which is why nothing could be dark.
  const yellow = minLightnessFor(0.15, 1, MIN_ELEMENT_LUMINANCE);
  const blue = minLightnessFor(0.66, 1, MIN_ELEMENT_LUMINANCE);
  assert.ok(yellow < blue - 0.1, `yellow ${yellow} should floor well below blue ${blue}`);
  assert.ok(yellow < 0.2, `yellow floor ${yellow} should be genuinely dark`);
});

test('every hue at its own floor still clears the visibility floor', () => {
  for (let i = 0; i <= 100; i += 1) {
    const h = i / 100;
    for (const s of [0, 0.5, 1]) {
      const l = minLightnessFor(h, s, MIN_ELEMENT_LUMINANCE);
      const L = relativeLuminance(hslToHex(h, s, l));
      assert.ok(L >= MIN_ELEMENT_LUMINANCE * 0.98,
        `h=${h} s=${s} floor l=${l} gives L=${L}`);
    }
  }
});

test('chaos now spans dark to bright instead of one band', () => {
  let lo = 1; let hi = 0;
  for (let seed = 0; seed < 2000; seed += 1) {
    for (const hex of Object.values(chaosColors(seeded(seed)))) {
      const L = relativeLuminance(hex);
      assert.ok(L >= MIN_ELEMENT_LUMINANCE, `seed ${seed}: ${hex} is invisible`);
      if (L < lo) lo = L;
      if (L > hi) hi = L;
    }
  }
  // The old band bottomed out around 0.09 and could not reach the extremes.
  assert.ok(lo < 0.05, `darkest chaos color L=${lo} -- still not dark enough`);
  assert.ok(hi > 0.75, `brightest chaos color L=${hi} -- still not bright enough`);
});

test('the arc floor is DERIVED from the sky, not invented', () => {
  // An arc must still lift the ground it is drawn on. That is the cap
  // relationship inverted: L_sky = L_arc * bodyOpacity / (LIFT - 1).
  const floor = arcLuminanceFloor(0.00324, 0.18, 2.85);
  assert.ok(Math.abs(floor - 0.0333) < 0.001, `got ${floor}`);
  // A brighter sky demands brighter arcs.
  assert.ok(arcLuminanceFloor(0.0065, 0.18, 2.85) > floor);
});

test('chaosPatch rolls the arcs, the planet and the limb -- never the sky', () => {
  const patch = chaosPatch(seeded(11), { skyLuminance: 0.00324 });
  for (const p of CHAOS_PATHS) assert.ok(p in patch, `${p} missing from the patch`);
  assert.equal(patch['appearance.background'], undefined, 'the sky must never be rolled');
  assert.equal(Object.keys(patch).length, CHAOS_PATHS.length);
});

test('rolled arcs stay visible against the sky, across every seed', () => {
  const floor = arcLuminanceFloor(0.00324, 0.18, 2.85);
  for (let seed = 0; seed < 2000; seed += 1) {
    const patch = chaosPatch(seeded(seed), { skyLuminance: 0.00324 });
    // flow and block only -- highlight arcs take their color from the rule
    // that matched them, so a class-level color there is never drawn.
    for (const cls of ['flow', 'block']) {
      const L = relativeLuminance(patch[`arcs.${cls}.color`]);
      assert.ok(L >= floor, `seed ${seed} ${cls}: L=${L} under floor ${floor}`);
    }
  }
});

test('surface tints leave every channel alive, so the map stays readable', () => {
  // A tint MULTIPLIES the baked texture per channel. The property that matters
  // is not the tint's luminance but that no CHANNEL is crushed: at saturation
  // 1.0 two channels go to zero and the planet reads as a dark monochrome
  // smear however light the third one is. Caught at seed 119 (a saturated blue
  // at l=0.5, L=0.11) before the saturation cap existed.
  for (let seed = 0; seed < 2000; seed += 1) {
    const patch = chaosPatch(seeded(seed), { skyLuminance: 0.00324 });
    for (const p of ['appearance.surface.dayTint', 'appearance.surface.nightTint']) {
      const hex = patch[p].replace('#', '');
      for (let c = 0; c < 3; c += 1) {
        const v = parseInt(hex.slice(c * 2, c * 2 + 2), 16) / 255;
        assert.ok(v >= 0.2, `seed ${seed} ${p}=#${hex}: channel ${c} at ${v} is crushed`);
      }
    }
  }
});

test('atmosphere rolls stay inside the schema bounds and never vanish', () => {
  for (let seed = 0; seed < 2000; seed += 1) {
    const patch = chaosPatch(seeded(seed), { skyLuminance: 0.00324 });
    for (const [path, [min, max]] of Object.entries(ATMOSPHERE_CHAOS)) {
      const v = patch[path];
      assert.ok(v >= min && v <= max, `seed ${seed} ${path}=${v} outside [${min},${max}]`);
    }
    assert.ok(patch['appearance.atmosphere.strength'] > 0,
      `seed ${seed}: a strength of 0 removes the limb entirely`);
  }
});
