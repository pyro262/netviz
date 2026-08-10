// Camera placement. All the motion logic lives in campath.js so it can be
// simulated under `node --test`; this file only turns a lat/lon into a
// position and averages the arc origins.
import { cfg } from './config.js';
import * as THREE from 'three';
import {
  step, initialState, startVisit, beginManual, endManual, isManual,
  setManualView, markInput, DEFAULTS,
} from './campath.js';
import { clampDistance } from './orbit.js';

// 3.1 radii put the globe's angular radius (18.8 deg) outside the 17.5 deg
// half-FOV of the 35 deg camera, clipping the limb on a 16:9 wall. 4.6 leaves
// the globe fully framed with room for the arcs standing off it.
const DISTANCE = cfg('camera.distance', 4.6);

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
  const minD = cfg('input.zoomRange.0', 3.3);
  const maxD = cfg('input.zoomRange.1', 9.0);
  // The framing the display owns. Zoom is borrowed exactly as orientation is:
  // without this, a passer-by who pulls the globe in to 3.3 radii and walks
  // off leaves the wall wrongly framed forever -- the view comes home after
  // resumeSeconds and the distance never does.
  const homeD = clampDistance(DISTANCE, minD, maxD);
  const zoomReturnEase = cfg('input.zoomReturnEase', 0.35);
  let distance = homeD;

  function place() {
    const phi = THREE.MathUtils.degToRad(90 - state.curLat);
    const theta = THREE.MathUtils.degToRad(-state.curLon);  // sign per latLonToVec3
    camera.position.set(
      distance * radius * Math.sin(phi) * Math.cos(theta),
      distance * radius * Math.cos(phi),
      distance * radius * Math.sin(phi) * Math.sin(theta),
    );
    camera.lookAt(0, 0, 0);
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
      place();
    },
    /** Go and look at a blocked country. Refused while a visit is running and,
     *  by default, while somebody is holding the globe. */
    visit(lat, lon) {
      return startVisit(state, lat, lon, params);
    },
    grab() { beginManual(state); },
    release() { endManual(state); },
    /** Somebody is still here. For inputs that are not a grab -- wheel, pinch,
     *  the zoom and arrow keys -- which must restart the idle countdown
     *  without claiming a pointer is down. */
    poke() { markInput(state); },
    held() { return state.held === true; },
    manual() { return isManual(state); },
    look(lat, lon) {
      setManualView(state, lat, lon, params);
      place();          // paint immediately: a drag must not wait for the next update
    },
    view() {
      return {
        lat: state.curLat,
        lon: state.curLon,
        distance,
        fovDeg: camera.fov,
        aspect: camera.aspect,
        // The solver clamps latitude inside its loop and must clamp to the
        // same limit the rig does, or a high-latitude drag solves to a pose
        // setManualView then clips -- and the globe slides out from under the
        // finger. Without this, orbit.js falls back to its own default, which
        // agrees only while camera.walk.latitudeClamp is left at 62.
        latClamp: params.latClamp,
      };
    },
    setDistance(d) { distance = clampDistance(d, minD, maxD); place(); },
    distance() { return distance; },
    zoomRange() { return [minD, maxD]; },
    state,
  };
}
