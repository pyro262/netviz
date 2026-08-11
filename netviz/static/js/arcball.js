// Free rotation for a hand on the globe. Imports nothing -- no three, no DOM,
// no config -- so drag feel is decided under `node --test` rather than by
// watching a wall. Same discipline as campath.js and for the same reason.
//
// WHY A QUATERNION AND NOT lat/lon.
//
// The autonomous camera is a latitude and a longitude with a fixed world-up
// vector, which is exactly right for a display that walks the temperate band:
// north stays up, and campath can be simulated in two numbers. It is also
// singular at the poles -- `lookAt` with an up vector parallel to the view
// direction has no solution -- so a drag expressed that way must stop short of
// 90, and a drag that stops while longitude keeps turning under the same finger
// reads as an axis lock rather than as a limit. That was the complaint this
// module answers.
//
// A quaternion has no such pole. The orientation carried here is the world ->
// camera rotation; the eye direction and the up vector both fall out of it, and
// a drag composes onto it without ever asking what latitude the camera is at.
// Going over the top genuinely turns the world upside down, and that is the
// honest answer rather than a bug: the up vector passes through the horizontal
// continuously on the way, so nothing snaps.
//
// The camera-space convention is three.js's: the camera sits at +Z looking down
// -Z, with +Y up and +X right, and the globe is a unit sphere at the origin.
// `distance` is therefore the camera's z in camera space.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function norm(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

function conj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

/** Composition, read right to left: `mul(a, b)` applies b first, then a. */
export function mul(a, b) {
  return norm({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
}

function rotate(q, v) {
  // t = 2 * (q.xyz x v); v' = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

function unit(v) {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Rotation of `deg` degrees about a unit axis, as a quaternion. */
export function fromAxisAngle(axis, deg) {
  const a = unit(axis);
  const h = deg * D2R / 2;
  const s = Math.sin(h);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(h) };
}

/** World direction the camera looks in FROM the origin -- i.e. where the eye
 *  is, as a unit vector. Camera space +Z, carried back into the world. */
export function eyeDirection(q) { return rotate(conj(q), { x: 0, y: 0, z: 1 }); }

/** World direction that renders as "up" on the screen. */
export function upVector(q) { return rotate(conj(q), { x: 0, y: 1, z: 0 }); }

/**
 * The upright pose over a lat/lon: eye there, world north as up.
 *
 * theta = -lon, matching latLonToVec3 in globe.js and latLonToUnit in orbit.js.
 * That sign is the load-bearing one in this project -- theta = +lon renders
 * every continent as its own mirror image.
 */
export function quatFromLatLon(lat, lon) {
  const phi = (90 - lat) * D2R;
  const theta = -lon * D2R;
  const z = {                       // camera +Z in world = the eye direction
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
  // Straight over a pole the north hint is parallel to the view and the basis
  // is degenerate. Nothing autonomous goes there, but a hand-back from a drag
  // that did must still resolve, so fall back to a hint that cannot be parallel.
  const hint = Math.abs(z.y) > 0.999999 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const x = unit(cross(hint, z));
  const y = cross(z, x);
  return matrixToQuat(x, y, z);
}

/** Rows of the world -> camera matrix are the camera's axes in world space. */
function matrixToQuat(x, y, z) {
  const m00 = x.x, m01 = x.y, m02 = x.z;
  const m10 = y.x, m11 = y.y, m12 = y.z;
  const m20 = z.x, m21 = z.y, m22 = z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return norm({ w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return norm({ w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return norm({ w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return norm({ w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 });
}

/** Where the camera is, in the two numbers the rest of the display speaks. The
 *  roll is dropped on purpose: campath owns lat/lon and nothing else. */
export function latLonFromQuat(q) {
  const e = eyeDirection(q);
  const lat = Math.asin(Math.max(-1, Math.min(1, e.y))) * R2D;
  const lon = -Math.atan2(e.z, e.x) * R2D;
  return { lat, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
}

/**
 * The sphere point under a normalised device coordinate, in CAMERA space.
 *
 * `clampToLimb` is what keeps a drag alive when the pointer leaves the globe --
 * which is most drags, since at 4.6 radii the globe's angular radius is 12.56
 * degrees against a 29.27 degree horizontal half-FOV and anything past about
 * 0.40 NDC on x misses it entirely. Without the clamp the pick returns null
 * out there and the globe stops dead under a finger that is still moving.
 */
export function pickCameraSphere(ndc, view, clampToLimb = false) {
  const tanV = Math.tan(view.fovDeg * D2R / 2);
  const dir = unit({ x: ndc.x * tanV * view.aspect, y: ndc.y * tanV, z: -1 });
  const d = view.distance;
  const b = d * dir.z;                       // dot(origin, dir), origin = (0,0,d)
  const c = d * d - 1;                       // unit sphere
  const disc = b * b - c;
  if (disc < 0) {
    if (!clampToLimb) return null;
    // Closest approach: the ray's nearest point to the centre, pushed out to
    // the surface. Continuous with the hit case at the limb, which is what
    // stops a drag jumping as the pointer crosses the edge.
    const p = { x: -b * dir.x, y: -b * dir.y, z: d - b * dir.z };
    return unit(p);
  }
  const t = -b - Math.sqrt(disc);
  return unit({ x: t * dir.x, y: t * dir.y, z: d + t * dir.z });
}

/** Shortest-arc rotation carrying unit vector `a` onto unit vector `b`. */
export function dragRotation(a, b) {
  const c = dot(a, b);
  if (c < -0.999999) {
    // Antipodal: every axis perpendicular to `a` is a half turn that works, so
    // pick one deterministically rather than dividing by a zero cross product.
    const axis = Math.abs(a.x) < 0.9 ? cross(a, { x: 1, y: 0, z: 0 })
                                     : cross(a, { x: 0, y: 1, z: 0 });
    return fromAxisAngle(axis, 180);
  }
  const v = cross(a, b);
  return norm({ x: v.x, y: v.y, z: v.z, w: 1 + c });
}

/**
 * Turn the globe so the point grabbed at `grab` sits under `hit`.
 *
 * Both are CAMERA-space unit vectors, so the world point being dragged never
 * enters into it -- which is why this works identically at the equator, at the
 * pole and upside down on the far side of a pole crossing.
 */
export function applyDrag(q, grab, hit) {
  if (!grab || !hit) return q;
  return mul(dragRotation(grab, hit), q);
}

/**
 * One pointermove of a drag: turn the globe by the step since the LAST move,
 * and hand back the reference the next step measures from.
 *
 * `ref` starts as the pick under the press and advances to each new `hit`,
 * because after a step the grabbed point is at `hit` -- that is what the step
 * just achieved. Measuring every move from the original press instead re-applies
 * nearly the whole rotation each time, so the turn per pixel scales with how
 * many move events the browser delivered: measured, the same 0.20 NDC path
 * turned the globe 24.4 degrees in one move and 110.3 degrees in twenty, which
 * on a fast display reads as wildly oversensitive.
 *
 * Inverting swaps the ends of the step. It is the same gesture backwards, and
 * in particular the same size -- an inverted drag is not a faster one.
 */
export function trackDrag(pose, ref, hit, invert = false) {
  if (!ref || !hit) return { pose, ref: ref || hit };
  const [from, to] = invert ? [hit, ref] : [ref, hit];
  return { pose: applyDrag(pose, from, to), ref: hit };
}

/** Turn the camera about one of its OWN axes -- what an arrow key wants. A
 *  world-axis turn would slow to nothing near a pole and reverse across it. */
export function rotateCamera(q, axisCam, deg) {
  return mul(fromAxisAngle(axisCam, deg), q);
}

/** Shortest-path interpolation. `t` is a fraction of the remaining gap, so the
 *  caller can ease with it exactly as campath eases lat/lon. */
export function slerp(a, b, t) {
  let c = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let end = b;
  if (c < 0) { end = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; c = -c; }
  if (c > 0.9995) {
    return norm({
      x: a.x + (end.x - a.x) * t, y: a.y + (end.y - a.y) * t,
      z: a.z + (end.z - a.z) * t, w: a.w + (end.w - a.w) * t,
    });
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, c)));
  const s = Math.sin(theta);
  const k0 = Math.sin((1 - t) * theta) / s;
  const k1 = Math.sin(t * theta) / s;
  return norm({
    x: a.x * k0 + end.x * k1, y: a.y * k0 + end.y * k1,
    z: a.z * k0 + end.z * k1, w: a.w * k0 + end.w * k1,
  });
}

/**
 * Split a rotation into the axis it turns about and how far, in degrees.
 *
 * This is what a fling coasts on: one frame's drag is a rotation, and dividing
 * its angle by the frame time gives an angular rate that decays. The axis for a
 * rotation of nothing is arbitrary but must still be a real unit vector -- a
 * NaN axis multiplied by a decaying zero rate turns the whole pose to NaN one
 * frame later and the display goes blank.
 */
export function axisAngle(q) {
  const n = norm(q);
  const s = Math.hypot(n.x, n.y, n.z);
  if (s < 1e-12) return { axis: { x: 0, y: 1, z: 0 }, deg: 0 };
  const w = Math.max(-1, Math.min(1, n.w));
  return {
    axis: { x: n.x / s, y: n.y / s, z: n.z / s },
    deg: 2 * Math.atan2(s, w) * R2D,
  };
}

/**
 * How far `q` is rolled about the view axis relative to `home`, in degrees,
 * signed. Meaningful when the two share an eye direction, which is exactly the
 * case the hand-back cares about: campath is already easing the position home,
 * and the only thing left to undo is the tilt.
 *
 * The whole-pose alternative -- slerp towards the upright of wherever campath
 * currently is -- unwinds at the speed of the FLIGHT rather than at the speed
 * asked for, because the target moves every frame. Measured on the live page:
 * a released view still sat 6 degrees off level 30 seconds after the hand-back.
 */
export function rollBetween(q, home) {
  const rel = mul(q, conj(home));
  const a = axisAngle(rel);
  const s = a.axis.z < 0 ? -1 : 1;
  const deg = a.deg * s;
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Angle between two orientations, in degrees. */
export function quatAngle(a, b) {
  const c = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}
