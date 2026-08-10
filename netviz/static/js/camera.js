// Camera placement. All the motion logic lives in campath.js so it can be
// simulated under `node --test`; this file only turns a lat/lon into a
// position and averages the arc origins.
import { cfg } from './config.js';
import * as THREE from 'three';
import { step, initialState, startVisit, DEFAULTS } from './campath.js';

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

  return {
    update(dt, origins) {
      const c = centroid(origins || []);
      const traffic = c === null ? null : {
        lat: THREE.MathUtils.radToDeg(Math.asin(c.y)),
        lon: -THREE.MathUtils.radToDeg(Math.atan2(c.z, c.x)),
      };

      step(state, dt, traffic, params);

      const phi = THREE.MathUtils.degToRad(90 - state.curLat);
      const theta = THREE.MathUtils.degToRad(-state.curLon);  // sign per latLonToVec3
      camera.position.set(
        DISTANCE * radius * Math.sin(phi) * Math.cos(theta),
        DISTANCE * radius * Math.cos(phi),
        DISTANCE * radius * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(0, 0, 0);
    },
    /** Go and look at a blocked country. Ignored while a visit is running;
     *  see startVisit in campath.js. */
    visit(lat, lon) {
      return startVisit(state, lat, lon);
    },
    state,
  };
}
