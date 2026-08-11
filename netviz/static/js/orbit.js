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
