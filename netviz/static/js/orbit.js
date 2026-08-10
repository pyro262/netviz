// Pointer maths for direct manipulation of the globe.
//
// Pure and dependency-free on purpose: no three, no DOM, no config. Every
// decision about where a drag sends the camera is decided here and simulated
// under `node --test`, the same discipline campath.js follows -- the
// alternative is judging drag feel by watching a wall, which is how the first
// camera work went wrong.
//
// The sign convention is latLonToVec3's: theta = -lon. Getting this wrong
// mirrors the globe, and it looks entirely plausible until you know a landmark.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// solveDrag's iteration. The cap is generous because the loop exits as soon
// as it converges -- reachable drags settle in about four passes -- and the
// trust region is what actually keeps it stable, not the cap.
const SOLVE_ITERATIONS = 8;
const SOLVE_MAX_STEP = 15;      // degrees, per iteration
const SOLVE_TOLERANCE = 1e-3;   // degrees
// Only for a caller that passes no view.latClamp. The rig always does, and it
// passes its OWN clamp -- this default agrees with campath only while that is
// left at 62, and a solver clamping to 62 while the camera clamps to 40 slides
// the globe out from under the finger at high latitude.
const DEFAULT_LAT_CLAMP = 62;

export function latLonToUnit(lat, lon) {
  const phi = (90 - lat) * D2R;
  const theta = -lon * D2R;
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
}

export function unitToLatLon(v) {
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v.y))) * R2D,
    lon: -Math.atan2(v.z, v.x) * R2D,
  };
}

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale(a, k) { return { x: a.x * k, y: a.y * k, z: a.z * k }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function norm(a) {
  const len = Math.sqrt(dot(a, a));
  return len < 1e-12 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / len);
}

/**
 * Where a screen point lands on the globe, or null if the ray misses it.
 *
 * ndcX/ndcY are normalised device coordinates: -1..1, y up, 0,0 at the centre.
 * The globe is the unit sphere at the origin and the camera looks straight at
 * it, so the centre ray always hits at exactly the camera's own lat/lon --
 * which is the fact solveDrag is built on.
 */
export function pickSphere(camLat, camLon, distance, ndcX, ndcY, fovDeg, aspect) {
  const eye = scale(latLonToUnit(camLat, camLon), distance);
  const forward = norm(scale(eye, -1));
  const worldUp = { x: 0, y: 1, z: 0 };
  let right = cross(forward, worldUp);
  if (dot(right, right) < 1e-12) right = { x: 1, y: 0, z: 0 };  // straight down a pole
  right = norm(right);
  const up = norm(cross(right, forward));

  const t = Math.tan((fovDeg * D2R) / 2);
  const dir = norm(add(add(forward, scale(right, ndcX * t * aspect)),
                       scale(up, ndcY * t)));

  // |eye + s*dir|^2 = 1
  const b = dot(eye, dir);
  const c = dot(eye, eye) - 1;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = -b - Math.sqrt(disc);
  if (s < 0) return null;
  return add(eye, scale(dir, s));
}

/**
 * The camera lat/lon that puts `grab` back under the pointer at `ndc`.
 *
 * Solved rather than mapped from pixels. A fixed degrees-per-pixel factor is
 * correct only at the screen centre and increasingly wrong toward the limb,
 * where a drag would slide out from under the finger.
 *
 * The method: the point under the screen centre IS the camera's lat/lon, so
 * the residual between the grabbed point and whatever is currently under the
 * pointer can be applied straight to the camera, and re-measured.
 *
 * Two guards make that iteration safe, and both were added because the naive
 * version failed measurably. A plain residual step is NOT a contraction near
 * the latitude clamp: a drag from (-62, 150) walked the camera to latitude
 * -430, straight past the pole, with the frame flipping on the way. So a
 * trust region caps any single step, and latitude is clamped inside the loop
 * exactly as the camera clamps it in reality. A drag whose solution needs a
 * pose the camera cannot hold then stops at the clamp -- which is the honest
 * answer, since the grabbed point genuinely cannot stay under the pointer.
 *
 * Measured over 175 camera/pointer combinations spanning the full clamp: every
 * reachable case lands within 0.01 deg, and no case diverges.
 *
 * `cam` is {lat, lon}, `view` is {distance, fovDeg, aspect, latClamp?}.
 */
export function solveDrag(cam, grab, ndc, view) {
  if (!grab) return { lat: cam.lat, lon: cam.lon };
  const clamp = view.latClamp === undefined ? DEFAULT_LAT_CLAMP : view.latClamp;
  const target = unitToLatLon(grab);
  let lat = cam.lat;
  let lon = cam.lon;
  for (let i = 0; i < SOLVE_ITERATIONS; i++) {
    const hit = pickSphere(lat, lon, view.distance, ndc.x, ndc.y,
                           view.fovDeg, view.aspect);
    if (!hit) break;
    const cur = unitToLatLon(hit);
    let dLat = target.lat - cur.lat;
    let dLon = ((target.lon - cur.lon + 540) % 360) - 180;
    if (Math.hypot(dLat, dLon) < SOLVE_TOLERANCE) break;
    const biggest = Math.max(Math.abs(dLat), Math.abs(dLon));
    if (biggest > SOLVE_MAX_STEP) {
      const k = SOLVE_MAX_STEP / biggest;
      dLat *= k;
      dLon *= k;
    }
    lat = Math.max(-clamp, Math.min(clamp, lat + dLat));
    lon += dLon;
  }
  return { lat, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
}

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
