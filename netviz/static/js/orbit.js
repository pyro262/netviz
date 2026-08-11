// Zoom and inertia maths for direct manipulation of the globe.
//
// Pure and dependency-free on purpose: no three, no DOM, no config. Every
// decision about what a gesture does to the camera is decided here or in
// arcball.js and simulated under `node --test`, the same discipline campath.js
// follows -- the alternative is judging drag feel by watching a wall, which is
// how the first camera work went wrong.
//
// This file used to carry the drag solver too: a lat/lon pick plus an iteration
// that walked the camera until the grabbed point was back under the pointer.
// arcball.js replaces it, because a lat/lon camera with a fixed up vector is
// singular at the poles and the solver therefore had to clamp short of them --
// which reads as an axis lock, since longitude keeps turning under the same
// finger while latitude refuses to. The old version, its trust region and its
// 175-case accuracy sweep are in git history if the reasoning is ever needed.

export function clampDistance(d, min, max) {
  return Math.max(min, Math.min(max, d));
}

/**
 * Check a proposed zoom range before anything is allowed to clamp against it.
 *
 * `clampDistance` propagates rather than refuses: an undefined bound makes
 * Math.min/Math.max return NaN, the camera position is then set to NaN, and the
 * display goes black with nothing in the console. That is reachable from a
 * settings patch -- `input.zoomRange` is a pair, and half a pair, a reversed
 * pair or a string in one slot all arrive here as ordinary input.
 *
 * Pure and here rather than in camera.js so the guard is unit-tested instead of
 * judged by watching a wall. Throws, because the caller (apply.js) already
 * turns a throw into a reported rejection that costs the rest of the patch
 * nothing -- and a silently substituted range would be the "control that lied"
 * the settings schema exists to prevent.
 *
 * @param floor the limb-clip threshold: below ~3.2 radii the globe's angular
 *              radius exceeds the 17.5 deg half-FOV of the 35 deg camera and
 *              the limb clips on a 16:9 wall. Not taste.
 */
export function validateZoomRange(min, max, floor = 3.3) {
  for (const v of [min, max]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`zoom range needs two finite numbers, got [${min}, ${max}]`);
    }
  }
  if (min < floor) {
    throw new Error(`zoom range floor ${min} is below ${floor}, where the limb clips`);
  }
  if (!(min < max)) {
    throw new Error(`zoom range ${min} is not below ${max}`);
  }
  return [min, max];
}

/** Multiplicative zoom, so a notch feels the same at every distance and in
 *  and out are exact inverses. */
export function zoomBy(d, notches, factor, min, max) {
  return clampDistance(d * Math.pow(factor, notches), min, max);
}

/** Exponential decay toward zero, framed so the result of one long step equals
 *  many short ones -- inertia that depends on frame rate feels different on
 *  every machine. `damping` is the fraction remaining after one second. */
export function decay(v, damping, dt) {
  const out = v * Math.pow(damping, dt);
  return Math.abs(out) < 1e-6 ? 0 : out;
}
