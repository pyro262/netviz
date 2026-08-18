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

export function hslToHex(h, s, l) {
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
    const h = rand();
    const s = rand();                      // 0 is allowed: greys are chaotic too
    // The floor is PER HUE, computed from the luminance formula rather than
    // guessed once for the worst case. It used to be a flat 0.45 -- which is
    // the answer a saturated blue needs, applied to every hue, so nothing
    // could ever be dark and twelve elements came out at the same weight.
    // A yellow clears the same visibility floor around l=0.12.
    const floor = minLightnessFor(h, s, MIN_ELEMENT_LUMINANCE);
    out[key] = hslToHex(h, s, floor + (0.985 - floor) * rand());
  }
  return out;
}

/** The lowest HSL lightness at which this hue and saturation still clears
 *  `target` relative luminance.
 *
 *  Bisection rather than algebra: the sRGB transfer function is piecewise and
 *  the HSL->RGB mapping is a max/min fold, so the closed form is three cases
 *  per hue sector and one of them is wrong at the boundaries. Luminance rises
 *  monotonically with lightness at fixed hue and saturation, which is the only
 *  property bisection needs. 24 iterations is far past 8-bit resolution. */
export function minLightnessFor(h, s, target) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(hslToHex(h, s, mid)) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

/** How bright a rolled arc must be to still lift the sky it is drawn on.
 *
 *  This is the sky cap's own relationship, inverted. settings.js derives the
 *  brightest legal ground from the flow arc:
 *      cap = L_arc * bodyOpacity / (LIFT - 1)
 *  so an arc that must clear a GIVEN ground needs
 *      L_arc = L_sky * (LIFT - 1) / bodyOpacity
 *  Chaos rolls arc colors but never the sky, so the sky is the fixed side and
 *  the arc is the side that has to comply. Deriving it means a display running
 *  a brighter ground automatically demands brighter arcs, with no second
 *  constant to keep in step. */
export function arcLuminanceFloor(skyLuminance, bodyOpacity, lift) {
  return (skyLuminance * (lift - 1)) / bodyOpacity;
}

/** Tints MULTIPLY the baked day/night textures, so a dark tint does not
 *  recolor the planet -- it blacks it out and takes the map with it. */
export const MIN_TINT_LIGHTNESS = 0.5;

/** ...and a SATURATED tint is the same failure by another route: saturation
 *  1.0 drives two of the three channels to zero, so the map survives in one
 *  channel and reads as a dark monochrome smear whatever its lightness. Found
 *  by the tint test at seed 119 -- a fully saturated blue at l=0.5 measures
 *  L=0.11, darker than the floor the lightness bound was supposed to buy.
 *  Capping saturation keeps every channel alive, which is what "tint" means
 *  as opposed to "replace". */
export const MAX_TINT_SATURATION = 0.6;

/** The limb glow's shape, and the schema bounds each roll stays inside.
 *  `strength` floors above 0 on purpose: 0 removes the atmosphere entirely,
 *  which is a missing layer rather than a chaotic one -- the same argument as
 *  MIN_ELEMENT_LUMINANCE one dimension over. */
export const ATMOSPHERE_CHAOS = {
  'appearance.atmosphere.power': [0.5, 8],
  'appearance.atmosphere.strength': [0.25, 2],
  'appearance.atmosphere.thickness': [1.005, 1.15],
};

// Flow and block only. `arcs.highlight` is the shared SHAPE for color rules
// and each rule carries its own hex, so a class-level color there would be
// rolled, stored, and never drawn -- a dead control, which this project treats
// as worse than a missing one.
const ARC_CLASSES = ['flow', 'block'];

/** Every schema path Chaos writes. The theme panel's snapshot is built from
 *  this, so Revert and Close cover the whole roll -- a path Chaos can write
 *  and Revert cannot restore is a one-way door. */
export const CHAOS_PATHS = [
  ...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL),
].map((k) => `appearance.colors.${k}`)
  .concat(ARC_CLASSES.map((c) => `arcs.${c}.color`))
  .concat(['appearance.surface.dayTint', 'appearance.surface.nightTint'])
  .concat(Object.keys(ATMOSPHERE_CHAOS));

/** Chaos: the whole display rolled independently, ignoring the ramp entirely.
 *
 *  The sky is NOT in the output. It is the one value that decides whether
 *  anything else is legible and the one path that refuses rather than clamps.
 *  Rolling it would make chaos a button that half the time reports an error --
 *  and everything else here is floored against the sky, so the sky has to be
 *  the fixed point for those floors to mean anything.
 *
 *  Arcs are included because they are the brightest, most-moving thing on the
 *  wall: rolling twelve outlines while the arcs stayed on the ramp read as the
 *  same globe with different edges. Block arcs stop being amber here, which
 *  does break "blocked = amber" across the display -- that vocabulary is
 *  exactly what this button exists to break, and Revert sits beside it. */
export function chaosPatch(rand = Math.random, opts = {}) {
  const {
    skyLuminance = 0.00324,        // #0b0916, the shipped sky
    bodyOpacity = 0.18,
    lift = 2.85,
  } = opts;
  const out = {};
  const colors = chaosColors(rand);
  for (const [key, hex] of Object.entries(colors)) {
    out[`appearance.colors.${key}`] = hex;
  }

  const arcFloor = arcLuminanceFloor(skyLuminance, bodyOpacity, lift);
  for (const cls of ARC_CLASSES) {
    const h = rand();
    const s = 0.35 + 0.65 * rand();     // arcs stay chromatic; grey arcs read as dead
    const floor = minLightnessFor(h, s, arcFloor);
    out[`arcs.${cls}.color`] = hslToHex(h, s, floor + (0.985 - floor) * rand());
  }

  for (const path of ['appearance.surface.dayTint', 'appearance.surface.nightTint']) {
    const h = rand();
    const s = MAX_TINT_SATURATION * rand();
    out[path] = hslToHex(h, s, MIN_TINT_LIGHTNESS + (1 - MIN_TINT_LIGHTNESS) * rand());
  }

  for (const [path, [min, max]] of Object.entries(ATMOSPHERE_CHAOS)) {
    out[path] = min + (max - min) * rand();
  }
  return out;
}
