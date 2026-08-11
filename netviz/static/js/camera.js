// Camera placement. All the motion logic lives in campath.js so it can be
// simulated under `node --test`; this file only turns a lat/lon into a
// position and averages the arc origins.
import { cfg } from './config.js';
import * as THREE from 'three';
import {
  step, initialState, startVisit, beginManual, endManual, isManual,
  setManualView, markInput, DEFAULTS,
} from './campath.js';
import { clampDistance, validateZoomRange } from './orbit.js';
import {
  quatFromLatLon, latLonFromQuat, eyeDirection, upVector, trackDrag,
  rotateCamera, quatAngle, rollBetween,
} from './arcball.js';

// The view axis in camera space. Rolling about it changes which way is up and
// nothing else, which is what makes the hand-back separable.
const CAM_Z = { x: 0, y: 0, z: 1 };

// 3.1 radii put the globe's angular radius (18.8 deg) outside the 17.5 deg
// half-FOV of the 35 deg camera, clipping the limb on a 16:9 wall. 4.6 leaves
// the globe fully framed with room for the arcs standing off it.
const DISTANCE = cfg('camera.distance', 4.6);

// Settings path -> the key it writes in campath's parameter object. The two
// names differ where config.js says what the setting IS to a reader and campath
// says what it does to the maths (`degreesPerSecond` / `walkRate`), so the
// mapping is written down once here rather than guessed at either end.
const PARAM_KEYS = {
  'camera.walk.enabled': 'walkEnabled',
  'camera.walk.cycleSeconds': 'cycleSeconds',
  'camera.walk.holdSeconds': 'holdSeconds',
  'camera.walk.returnMaxSeconds': 'returnMaxSeconds',
  'camera.walk.arriveDegrees': 'arriveDegrees',
  'camera.walk.degreesPerSecond': 'walkRate',
  'camera.walk.latitudeClamp': 'latClamp',
  'camera.detour.enabled': 'detourEnabled',
  'camera.detour.visitSeconds': 'visitSeconds',
  'camera.detour.visitMaxSeconds': 'visitMaxSeconds',
  'camera.detour.interruptManual': 'detourInterruptManual',
  'input.resumeSeconds': 'resumeSeconds',
};

/** Weighted mean direction of arc origins, as a unit vector. Averaging
 *  vectors rather than lat/lon avoids the wrap-around bug that makes a camera
 *  looking at the Pacific swing to Africa. */
function centroid(origins) {
  const acc = new THREE.Vector3();
  for (const o of origins) {
    const phi = THREE.MathUtils.degToRad(90 - o.lat);
    const theta = THREE.MathUtils.degToRad(-o.lon);   // sign per latLonToVec3
    acc.x += o.w * Math.sin(phi) * Math.cos(theta);
    acc.y += o.w * Math.cos(phi);
    acc.z += o.w * Math.sin(phi) * Math.sin(theta);
  }
  return acc.lengthSq() < 1e-9 ? null : acc.normalize();
}

export function createCameraRig(camera, radius, params = DEFAULTS) {
  const state = initialState();
  // Mutable, because the wheel and pinch move it. The floor is not a taste
  // decision: below ~3.2 radii the globe's angular radius exceeds the 17.5 deg
  // half-FOV and the limb clips on a 16:9 wall.
  // Validated at boot as well as on write, but the two failures want opposite
  // answers: a settings patch is REJECTED and reported, while a hand-edited
  // config.js falls back to the shipped pair with a warning. Throwing here
  // would blank the wall over an edit somebody made months ago, which is the
  // one outcome worse than ignoring their number.
  let minD = cfg('input.zoomRange.0', 3.3);
  let maxD = cfg('input.zoomRange.1', 9.0);
  try {
    validateZoomRange(minD, maxD);
  } catch (err) {
    console.warn(`${err.message}; falling back to [3.3, 9.0]`);
    minD = 3.3;
    maxD = 9.0;
  }
  // The framing the display owns. Zoom is borrowed exactly as orientation is:
  // without this, a passer-by who pulls the globe in to 3.3 radii and walks
  // off leaves the wall wrongly framed forever -- the view comes home after
  // resumeSeconds and the distance never does.
  let homeD = clampDistance(DISTANCE, minD, maxD);
  let zoomReturnEase = cfg('input.zoomReturnEase', 0.35);
  let rollReturnEase = cfg('input.rollReturnEase', 0.6);
  let distance = homeD;

  // The pose a HAND has put the camera in, as a world -> camera quaternion, or
  // null whenever the display owns the view. Two representations, because they
  // answer two different questions: the walk is a latitude and a longitude with
  // world north up, which is simulable in two numbers and is what every other
  // module speaks; a drag is a free rotation, which has no pole to stop at and
  // no north to keep up. campath still holds lat/lon throughout -- every drag
  // writes the pose's own lat/lon back into it -- so the hand-back has
  // somewhere to return FROM and the rest of the display is none the wiser.
  let pose = null;
  // Hand-back only: the residual tilt in degrees, and whether it has been read
  // off the pose yet. Cleared by any new input, or the next drag would inherit
  // an unwind that was half-finished.
  let roll = 0;
  let unwinding = false;

  function place() {
    if (pose) {
      const e = eyeDirection(pose);
      const u = upVector(pose);
      const d = distance * radius;
      camera.position.set(e.x * d, e.y * d, e.z * d);
      // lookAt resolves the roll through camera.up, so the up vector has to be
      // set BEFORE it, and reset to world north the moment the pose is dropped
      // -- otherwise the autonomous walk inherits whatever roll the last drag
      // left and the wall runs tilted until the next reload.
      camera.up.set(u.x, u.y, u.z);
      camera.lookAt(0, 0, 0);
      return;
    }
    const phi = THREE.MathUtils.degToRad(90 - state.curLat);
    const theta = THREE.MathUtils.degToRad(-state.curLon);  // sign per latLonToVec3
    camera.position.set(
      distance * radius * Math.sin(phi) * Math.cos(theta),
      distance * radius * Math.cos(phi),
      distance * radius * Math.sin(phi) * Math.sin(theta),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
  }

  /** Write a hand's pose back into the two numbers campath owns, so a hand-back
   *  starts from where the view actually is. */
  function syncPose() {
    const ll = latLonFromQuat(pose);
    setManualView(state, ll.lat, ll.lon, params);
    place();          // paint immediately: a drag must not wait for the next update
  }

  /** The pose the autonomous camera would be in right now: same lat/lon, no
   *  roll. What a hand-back eases towards. */
  function uprightNow() { return quatFromLatLon(state.curLat, state.curLon); }

  function ensurePose() {
    unwinding = false;      // a hand is back on it; whatever was unwinding stops
    if (!pose) pose = uprightNow();
  }

  /**
   * Unwind the roll a drag left behind, once the display has taken itself back.
   *
   * A drag over a pole legitimately leaves the world upside down, and campath
   * knows nothing about that -- it would go on easing lat/lon home while the
   * horizon stayed inverted for ever.
   *
   * Position and roll are unwound SEPARATELY, and that is not a stylistic
   * choice. Slerping the whole pose towards the upright of wherever campath
   * currently is looks equivalent and is not: the target moves every frame with
   * the return leg, so what converges is the gap between two moving things
   * rather than the tilt. Measured on the live page, a released view was still
   * 6 degrees off level 30 seconds after the hand-back and only levelled when
   * the camera stopped. Taking the roll as a number, easing THAT to zero, and
   * rebuilding the pose from campath's own lat/lon each frame gives the
   * position to campath and the roll to rollReturnEase, with neither waiting on
   * the other.
   */
  function easeRollHome(dt) {
    if (!pose || isManual(state)) return;
    if (!unwinding) {
      // Read the tilt once, at the moment the display takes the view back.
      // Valid here precisely because every drag synced its own lat/lon into
      // campath, so `pose` and `uprightNow()` still share an eye direction.
      roll = rollBetween(pose, uprightNow());
      unwinding = true;
    }
    roll -= roll * Math.min(1, rollReturnEase * dt);
    // Level enough to hand back to the plain lat/lon path, which is also the
    // only thing that clears camera.up. An exponential never actually lands,
    // and a pose a millionth off upright is a permanent no-op that isn't.
    if (Math.abs(roll) < 0.05) { pose = null; roll = 0; unwinding = false; return; }
    pose = rotateCamera(uprightNow(), CAM_Z, roll);
  }

  /** Ease the distance back to the configured framing once the display has
   *  taken itself back. Same easing style as campath's -- a fraction of the
   *  remaining gap per second -- so it reads as the same motion, and it never
   *  runs while somebody has the globe, or it would fight a live pinch. */
  function easeDistanceHome(dt) {
    if (isManual(state)) return;
    if (distance === homeD) return;                 // no-op at home
    const k = Math.min(1, zoomReturnEase * dt);
    distance += (homeD - distance) * k;
    // Snap rather than approach forever; an exponential never actually lands,
    // and a distance a millionth off home is a permanent no-op that isn't.
    if (Math.abs(homeD - distance) < 1e-4) distance = homeD;
    distance = clampDistance(distance, minD, maxD);
  }

  return {
    update(dt, origins) {
      const c = centroid(origins || []);
      const traffic = c === null ? null : {
        lat: THREE.MathUtils.radToDeg(Math.asin(c.y)),
        lon: -THREE.MathUtils.radToDeg(Math.atan2(c.z, c.x)),
      };
      step(state, dt, traffic, params);
      easeDistanceHome(dt);
      easeRollHome(dt);
      place();
    },
    /** Go and look at a blocked country. Refused while a visit is running and,
     *  by default, while somebody is holding the globe. */
    visit(lat, lon) {
      return startVisit(state, lat, lon, params);
    },
    grab() { beginManual(state); ensurePose(); },
    release() { endManual(state); },
    /** Somebody is still here. For inputs that are not a grab -- wheel, pinch,
     *  the zoom and arrow keys -- which must restart the idle countdown
     *  without claiming a pointer is down. */
    poke() { markInput(state); },
    held() { return state.held === true; },
    manual() { return isManual(state); },
    /** One step of a drag: turn the globe so the point at `ref` moves to `hit`.
     *  Both are camera-space unit vectors from arcball.pickCameraSphere, and
     *  `ref` is the PREVIOUS move's hit, not the original press -- see
     *  arcball.trackDrag for what happens otherwise. */
    drag(ref, hit, invert = false) {
      ensurePose();
      ({ pose } = trackDrag(pose, ref, hit, invert));
      syncPose();
    },
    /** Turn about one of the camera's OWN axes: a fling coasting, or an arrow
     *  key. Camera-space, so it behaves the same at the equator and at a pole. */
    spin(axisCam, deg) {
      ensurePose();
      pose = rotateCamera(pose, axisCam, deg);
      syncPose();
    },
    /** The rolled-ness of the current view, in degrees -- 0 when world north is
     *  up. For verification from the console; nothing in the page reads it. */
    roll() { return pose ? quatAngle(pose, uprightNow()) : 0; },
    view() {
      return {
        lat: state.curLat,
        lon: state.curLon,
        distance,
        fovDeg: camera.fov,
        aspect: camera.aspect,
      };
    },
    /**
     * One live setting that the rig or the motion maths owns.
     *
     * Keyed by the settings path rather than by a short name, so apply.js can
     * hand it straight through and there is no second vocabulary to keep in
     * step. Everything in PARAM_KEYS lands in campath's parameter object --
     * which is `DEFAULTS` unless a caller passed its own -- and the rest are
     * this file's own fields.
     */
    setParam(path, value) {
      if (PARAM_KEYS[path]) { params[PARAM_KEYS[path]] = value; return; }
      if (path === 'camera.distance') {
        homeD = clampDistance(value, minD, maxD);
        // Nobody is holding it: put the display's own framing on screen now
        // rather than waiting for the next hand-back that may never come.
        if (!isManual(state)) { distance = homeD; place(); }
        return;
      }
      // The zoom range moves as a PAIR, never one end at a time.
      //
      // The schema declares two bounded numbers so each end gets its own limits,
      // but the accept/reject decision belongs to the final pair alone. Taking
      // one end at a time and checking it against whatever the other end
      // currently is makes a two-sided shift order-dependent: moving [3.3, 5.0]
      // up to [8.0, 12.0] validates 8.0 against a stale 5.0 and is refused,
      // or not, depending on which key the executor happened to reach first.
      // A control that rejects valid input intermittently is worse than the NaN
      // this guard replaced. apply.js therefore composes the final pair and
      // hands it here whole; see the zoomRange handlers there.
      //
      // Validated BEFORE anything is assigned: clampDistance propagates a bad
      // bound as NaN rather than refusing it, so an unchecked write reaches
      // camera.position and blanks the wall with nothing in the console. A
      // rejected pair must leave BOTH ends as they were. The throw becomes a
      // reported rejection.
      if (path === 'input.zoomRange') {
        const [lo, hi] = validateZoomRange(value[0], value[1]);
        minD = lo;
        maxD = hi;
        homeD = clampDistance(homeD, minD, maxD);
        distance = clampDistance(distance, minD, maxD);
        place();
        return;
      }
      if (path === 'input.zoomReturnEase') { zoomReturnEase = value; return; }
      if (path === 'input.rollReturnEase') { rollReturnEase = value; return; }
      throw new Error(`camera: no parameter ${path}`);
    },
    setDistance(d) { distance = clampDistance(d, minD, maxD); place(); },
    distance() { return distance; },
    zoomRange() { return [minD, maxD]; },
    state,
  };
}
