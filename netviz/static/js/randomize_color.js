// The two randomizers.
//
// Both produce valid values BY CONSTRUCTION, never by rolling and hoping. The
// tuning panel's Randomize deliberately skips the one color row it has,
// because the luminance cap refuses rather than clamps and a randomizer aimed
// at it "would spend half its rolls being rejected and read as a broken
// button". Same rule here.
import { ELEMENT_T, ELEMENT_LITERAL } from './elements.js';

/** Below this an element is not chaotic, it is missing. Same argument as the
 *  0.05 floor on arcs.*.gain: an invisible element reads as a broken display,
 *  and chaos is meant to be ugly rather than absent. */
export const MIN_ELEMENT_LUMINANCE = 0.02;

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Local copy of settings.js's relativeLuminance -- deliberately not imported.
 *  This module stays coupled to nothing but elements.js; duplicating six lines
 *  of arithmetic is cheaper than a cross-module dependency for a sort key. */
function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const chan = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

/** A coherent ramp: one hue family, rotating, with lightness rising across the
 *  ten stops.
 *
 *  Monotonic lightness is not decoration -- it is what makes the derived
 *  luminance cap computable and the shipped sky legal for any rolled ramp. The
 *  failure mode of ten independent colors is a dark stop where the code assumes
 *  a bright one, and that failure is silent.
 *
 *  HSL lightness alone does not guarantee monotonic RELATIVE luminance: the
 *  sRGB channel weights are hue-dependent (0.7152 green vs 0.0722 blue), so a
 *  rotating hue can make a nominally-brighter stop measure darker. Rather than
 *  narrow the rotation and hope no seed crosses the line, the stops are sorted
 *  by their actual relative luminance after construction -- still zero
 *  rejection, just an order guarantee applied to the generated set instead of
 *  to the generation order. */
export function randomizeRamp(rand = Math.random) {
  const baseHue = rand();
  const rotation = (rand() - 0.5) * 0.5;      // bounded: ends stay related
  const stops = [];
  for (let i = 0; i < 10; i += 1) {
    const f = i / 9;
    const h = (baseHue + rotation * f + 1) % 1;
    // Lightness climbs 0.12 -> 0.92 across the roll; combined with the sort
    // below this keeps the ramp reading as "dark end to light end" rather
    // than shuffled, even though the sort is what actually enforces it.
    const l = 0.12 + 0.80 * f;
    // Saturation falls as lightness rises, which is what keeps the bright end
    // from being a flat wash and the dark end from being grey.
    const s = 0.85 - 0.45 * f;
    stops.push(hslToHex(h, s, l));
  }
  return stops.sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
}

/** Chaos: every element rolled independently, ignoring the ramp entirely.
 *
 *  The sky is NOT in the output. It is the one value that decides whether
 *  anything else is legible and the one path that refuses rather than clamps.
 *  Rolling it would make chaos a button that half the time reports an error. */
export function chaosColors(rand = Math.random) {
  const keys = [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)];
  const out = {};
  for (const key of keys) {
    // Lightness floored well above MIN_ELEMENT_LUMINANCE so the constructed
    // value clears it for every hue -- luminance is hue-weighted, and a
    // saturated blue at l=0.3 is far darker than a yellow at the same l.
    const l = 0.45 + 0.40 * rand();
    out[key] = hslToHex(rand(), 0.55 + 0.45 * rand(), l);
  }
  return out;
}
