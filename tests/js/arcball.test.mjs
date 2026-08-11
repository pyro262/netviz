import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY, quatFromLatLon, latLonFromQuat, eyeDirection, upVector,
  pickCameraSphere, dragRotation, applyDrag, rotateCamera, slerp, quatAngle,
  fromAxisAngle, axisAngle, rollBetween, trackDrag, vecToLatLon, unrotate,
} from '../../netviz/static/js/arcball.js';

const D = 4.6;
const FOV = 35;
const ASPECT = 16 / 9;
const VIEW = { distance: D, fovDeg: FOV, aspect: ASPECT };

const deg = (r) => r * 180 / Math.PI;
const angleBetween = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1,
  a.x * b.x + a.y * b.y + a.z * b.z))));

test('quatFromLatLon puts the eye over that lat/lon, north up', () => {
  for (const [lat, lon] of [[0, 0], [40, -74], [-35, 150], [62, 179]]) {
    const q = quatFromLatLon(lat, lon);
    const back = latLonFromQuat(q);
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${lat} -> ${back.lat}`);
    assert.ok(Math.abs(((back.lon - lon + 540) % 360) - 180) < 1e-6,
              `lon ${lon} -> ${back.lon}`);
    // Up is the world north hint, so a fresh grab does not roll the horizon.
    assert.ok(upVector(q).y > 0, `up.y = ${upVector(q).y} at ${lat},${lon}`);
  }
});

test('the eye direction matches the renderer sign convention', () => {
  // theta = -lon, as in latLonToVec3. East of Greenwich has NEGATIVE z, or the
  // globe mirrors -- the one sign in this project that is load-bearing.
  const e = eyeDirection(quatFromLatLon(0, 90));
  assert.ok(e.z < -0.99, `east z was ${e.z}`);
});

test('the screen centre picks the point nearest the camera', () => {
  const p = pickCameraSphere({ x: 0, y: 0 }, VIEW);
  assert.ok(Math.abs(p.z - 1) < 1e-9, `centre picked ${JSON.stringify(p)}`);
});

test('a ray past the limb misses, and clamps to the limb when asked', () => {
  const off = { x: 0.9, y: 0.9 };
  assert.equal(pickCameraSphere(off, VIEW), null);
  const limb = pickCameraSphere(off, VIEW, true);
  assert.notEqual(limb, null);
  assert.ok(Math.abs(Math.hypot(limb.x, limb.y, limb.z) - 1) < 1e-9, 'not a unit vector');
});

test('the limb clamp is continuous with the hit it takes over from', () => {
  // What matters is not where a far-off ray lands but that nothing JUMPS as the
  // pointer crosses the edge of the globe mid-drag. The globe's angular radius
  // at 4.6 radii is 12.56 deg, so the silhouette on a 16:9 35 deg camera sits
  // near x = 0.40 NDC -- straddle it.
  // Bisect to the silhouette rather than stepping onto it. A grazing ray's hit
  // moves as sqrt(distance from the edge), so a coarse pair of samples differs
  // by degrees on geometry alone and would say nothing about this function.
  let lo = 0.30, hi = 0.55;
  assert.notEqual(pickCameraSphere({ x: lo, y: 0 }, VIEW), null, 'lo missed the globe');
  assert.equal(pickCameraSphere({ x: hi, y: 0 }, VIEW), null, 'hi hit the globe');
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pickCameraSphere({ x: mid, y: 0 }, VIEW) === null) hi = mid; else lo = mid;
  }
  const inside = pickCameraSphere({ x: lo, y: 0 }, VIEW, true);
  const outside = pickCameraSphere({ x: hi, y: 0 }, VIEW, true);
  assert.ok(angleBetween(inside, outside) < 1.0,
    `the pick jumped ${angleBetween(inside, outside)} deg across the limb`);
});

test('applyDrag puts the grabbed point back under the pointer', () => {
  for (const [lat, lon] of [[0, 0], [40, -74], [-35, 150], [20, 100]]) {
    const q = quatFromLatLon(lat, lon);
    const grab = pickCameraSphere({ x: 0, y: 0 }, VIEW);
    const to = { x: 0.25, y: 0.18 };
    const hit = pickCameraSphere(to, VIEW);
    const q2 = applyDrag(q, grab, hit);
    // The grabbed world point, re-picked in the new camera frame, must land on
    // the sphere point the pointer is now over.
    const worldGrab = rotateInverse(q, grab);
    const nowCam = rotate(q2, worldGrab);
    assert.ok(angleBetween(nowCam, hit) < 0.01,
      `from ${lat},${lon}: off by ${angleBetween(nowCam, hit)} deg`);
  }
});

test('a drag tracks the pointer over MANY moves, not just one', () => {
  // The bug this exists to prevent: applying the rotation from the ORIGINAL
  // grab point on every pointermove. After the first move the grabbed point is
  // already under the pointer, so every later event re-applies nearly the whole
  // rotation and sensitivity scales with the number of move events -- i.e. with
  // frame rate. Measured on the shipped version: the same 0.20 NDC pointer path
  // turned the globe 24.4 degrees in one move and 110.3 degrees in twenty.
  const start = quatFromLatLon(0, 0);
  let ref = pickCameraSphere({ x: 0, y: 0 }, VIEW, true);
  const world = rotateInverse(start, ref);      // the point actually grabbed
  let pose = start;
  const N = 20;
  const END = 0.2;
  for (let i = 1; i <= N; i++) {
    const hit = pickCameraSphere({ x: END * i / N, y: 0 }, VIEW, true);
    ({ pose, ref } = trackDrag(pose, ref, hit));
    // It must track at EVERY step, not merely arrive in the right place.
    assert.ok(angleBetween(rotate(pose, world), hit) < 0.01,
      `step ${i}: grabbed point is ${angleBetween(rotate(pose, world), hit)} deg off`);
  }
  // And the whole gesture equals the single move that spans it.
  const once = applyDrag(start, pickCameraSphere({ x: 0, y: 0 }, VIEW, true),
                         pickCameraSphere({ x: END, y: 0 }, VIEW, true));
  assert.ok(quatAngle(pose, once) < 0.01,
    `twenty small moves != one big one, off by ${quatAngle(pose, once)} deg`);
});

test('an inverted drag is the same gesture backwards, not a faster one', () => {
  const start = quatFromLatLon(10, 20);
  const first = pickCameraSphere({ x: 0, y: 0 }, VIEW, true);
  let ref = first;
  let pose = start;
  for (let i = 1; i <= 10; i++) {
    const hit = pickCameraSphere({ x: 0.02 * i, y: 0 }, VIEW, true);
    ({ pose, ref } = trackDrag(pose, ref, hit, true));
  }
  const plain = applyDrag(start, first, pickCameraSphere({ x: 0.2, y: 0 }, VIEW, true));
  // Same magnitude as the uninverted gesture, opposite direction.
  assert.ok(Math.abs(quatAngle(start, pose) - quatAngle(start, plain)) < 0.01,
    `inverted turned ${quatAngle(start, pose)} vs ${quatAngle(start, plain)}`);
  assert.ok(quatAngle(pose, plain) > 1, 'inverted went the same way as plain');
});

// Local helpers: the module's rotate is internal, so re-derive it from the
// public surface -- a quaternion applied to a vector, and its inverse.
function rotate(q, v) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
function rotate_inv(q, v) { return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v); }
function rotateInverse(q, v) { return rotate_inv(q, v); }

test('a sustained upward drag goes over the pole and keeps going', () => {
  // The whole point of the arcball. A lat/lon camera with a fixed up vector is
  // singular at the pole and has to be clamped short of it; a quaternion is
  // not, so the drag never stalls and never flips.
  let q = quatFromLatLon(60, 0);
  const grab = pickCameraSphere({ x: 0, y: 0 }, VIEW);
  const step = pickCameraSphere({ x: 0, y: -0.1 }, VIEW);
  const perStep = angleBetween(grab, step);          // 6.53 deg on this view
  const lats = [];
  let eye = eyeDirection(q);
  for (let i = 0; i < 40; i++) {                     // 40 * 6.53 = 261 degrees
    q = applyDrag(q, grab, step);
    const ll = latLonFromQuat(q);
    assert.ok(Number.isFinite(ll.lat) && Number.isFinite(ll.lon),
      `diverged at step ${i}`);
    lats.push(ll.lat);
    // The eye advances by the SAME angle on every step, including the ones
    // either side of the pole. This is the whole claim: nothing stalls, nothing
    // is clamped, and no step is special.
    const next = eyeDirection(q);
    assert.ok(Math.abs(angleBetween(eye, next) - perStep) < 1e-6,
      `step ${i} moved ${angleBetween(eye, next)} deg, not ${perStep}`);
    eye = next;
  }
  assert.ok(Math.max(...lats) > 85, `never neared the pole: ${Math.max(...lats)}`);
  // Past the pole the eye comes back DOWN the far side -- the drag continued
  // rather than stopping at 90 -- and keeps going into the other hemisphere.
  assert.ok(Math.min(...lats) < -30, `never came down the far side: ${Math.min(...lats)}`);
});

test('crossing the pole rolls the horizon rather than mirroring the globe', () => {
  // Going over the top genuinely turns the world upside down. What must NOT
  // happen is an abrupt mirror: the up vector has to pass through the
  // horizontal continuously.
  let q = quatFromLatLon(80, 0);
  const grab = pickCameraSphere({ x: 0, y: 0 }, VIEW);
  const step = pickCameraSphere({ x: 0, y: -0.1 }, VIEW);
  const ups = [upVector(q).y];
  for (let i = 0; i < 40; i++) {
    q = applyDrag(q, grab, step);
    ups.push(upVector(q).y);
  }
  assert.ok(Math.min(...ups) < -0.9, `never inverted: ${Math.min(...ups)}`);
  for (let i = 1; i < ups.length; i++) {
    assert.ok(Math.abs(ups[i] - ups[i - 1]) < 0.2,
      `up jumped from ${ups[i - 1]} to ${ups[i]} at step ${i}`);
  }
});

test('a drag that leaves the globe keeps turning it', () => {
  // Dragging off the limb is the ordinary way a fling ends. Without the limb
  // clamp the pick returns null there and the globe stops dead under a finger
  // that is still moving.
  const q = quatFromLatLon(0, 0);
  const grab = pickCameraSphere({ x: 0, y: 0 }, VIEW);
  const far = pickCameraSphere({ x: 0.95, y: 0.4 }, VIEW, true);
  const q2 = applyDrag(q, grab, far);
  assert.ok(quatAngle(q, q2) > 30, `barely moved: ${quatAngle(q, q2)} deg`);
});

test('rotateCamera turns about camera axes, so arrows work at the pole', () => {
  const q = quatFromLatLon(89, 0);
  const up = rotateCamera(q, { x: 1, y: 0, z: 0 }, 5);   // pitch up 5 degrees
  assert.ok(Math.abs(quatAngle(q, up) - 5) < 1e-6, `moved ${quatAngle(q, up)}`);
  const ll = latLonFromQuat(up);
  assert.ok(Number.isFinite(ll.lat) && Number.isFinite(ll.lon), 'diverged at 89N');
});

test('slerp walks a rolled view back to upright and lands exactly', () => {
  const rolled = rotateCamera(quatFromLatLon(70, 20), { x: 0, y: 0, z: 1 }, 140);
  const home = quatFromLatLon(70, 20);
  assert.ok(quatAngle(rolled, home) > 100, 'not actually rolled');
  let q = rolled;
  let last = quatAngle(q, home);
  for (let i = 0; i < 200; i++) {
    q = slerp(q, home, 0.1);
    const now = quatAngle(q, home);
    // Not `<= last`: quatAngle is an acos near 1 once the slerp has arrived,
    // where float noise is amplified into microdegrees. The claim under test is
    // that the roll never grows VISIBLY.
    assert.ok(now <= Math.max(last, 1e-3), `roll grew: ${last} -> ${now}`);
    last = now;
  }
  assert.ok(last < 0.5, `never arrived: ${last} deg out`);
});

test('slerp takes the short way round', () => {
  const a = quatFromLatLon(0, 0);
  const b = quatFromLatLon(0, 179);
  const mid = slerp(a, b, 0.5);
  assert.ok(Math.abs(latLonFromQuat(mid).lon - 89.5) < 1e-6,
    `went the long way: ${latLonFromQuat(mid).lon}`);
});

test('axisAngle decomposes a drag into the spin an inertia can coast on', () => {
  const q = fromAxisAngle({ x: 0, y: 1, z: 0 }, 12);
  const a = axisAngle(q);
  assert.ok(Math.abs(a.deg - 12) < 1e-9, `angle ${a.deg}`);
  assert.ok(angleBetween(a.axis, { x: 0, y: 1, z: 0 }) < 1e-6, 'axis moved');
  // Round trip: the decomposition must rebuild the rotation it came from.
  const back = fromAxisAngle(a.axis, a.deg);
  // 1e-4 deg: quatAngle is an acos of a dot product near 1, so it reads float
  // noise back as microdegrees. The components themselves agree to 1e-16.
  assert.ok(quatAngle(q, back) < 1e-4, `round trip off by ${quatAngle(q, back)}`);
});

test('axisAngle gives a usable axis for a rotation of nothing', () => {
  // A frame where the pointer did not move produces the identity, and an
  // inertia that reads NaN out of it coasts the globe to a blank screen.
  const a = axisAngle(IDENTITY);
  assert.equal(a.deg, 0);
  assert.ok(Math.abs(Math.hypot(a.axis.x, a.axis.y, a.axis.z) - 1) < 1e-12,
    'axis is not a unit vector');
});

test('rollBetween reads back the tilt about the view axis, with a sign', () => {
  // The hand-back needs the roll as a NUMBER, not as a second orientation to
  // interpolate towards: the position is already being eased home by campath,
  // and slerping a whole pose towards a target that is itself moving unwinds
  // the tilt at the speed of the flight rather than at the speed asked for.
  const home = quatFromLatLon(35, -100);
  for (const deg of [0, 12, -12, 179, -179]) {
    const rolled = rotateCamera(home, { x: 0, y: 0, z: 1 }, deg);
    assert.ok(Math.abs(rollBetween(rolled, home) - deg) < 1e-6,
      `${deg} read back as ${rollBetween(rolled, home)}`);
  }
});

test('a roll can be rebuilt from the number, so nothing else drifts', () => {
  const home = quatFromLatLon(-20, 44);
  const rolled = rotateCamera(home, { x: 0, y: 0, z: 1 }, 63);
  const back = rotateCamera(home, { x: 0, y: 0, z: 1 }, rollBetween(rolled, home));
  assert.ok(quatAngle(rolled, back) < 1e-4, `off by ${quatAngle(rolled, back)}`);
});

// camera.js's pointAt() is built from three pieces that are all covered
// elsewhere in this file already -- pickCameraSphere's null-past-the-limb
// behaviour, and the eye-direction convention -- so the coverage that is
// actually new here is the pose round-trip: unrotate() carrying a
// camera-space pick into world space, then vecToLatLon() reading it back.
test('a point picked at screen centre carries back to the camera\'s own lat/lon', () => {
  for (const [lat, lon] of [[0, 0], [40, -74], [-35, 150], [62, 179]]) {
    const pose = quatFromLatLon(lat, lon);
    const hit = pickCameraSphere({ x: 0, y: 0 }, VIEW);   // nearest point: {0,0,1}
    const world = unrotate(pose, hit);
    const back = vecToLatLon(world);
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${lat} -> ${back.lat}`);
    assert.ok(Math.abs(((back.lon - lon + 540) % 360) - 180) < 1e-6,
      `lon ${lon} -> ${back.lon}`);
  }
});

test('unrotate is the exact inverse of the rotation eyeDirection/upVector apply', () => {
  // eyeDirection(q) is rotate(conj(q), {0,0,1}) internally -- unrotate must
  // agree with it on that same vector, or pointAt and the camera's own
  // placement would silently disagree about which way "world space" is.
  const pose = quatFromLatLon(22, -60);
  const camZ = { x: 0, y: 0, z: 1 };
  const viaEyeDirection = eyeDirection(pose);
  const viaUnrotate = unrotate(pose, camZ);
  assert.ok(angleBetween(viaEyeDirection, viaUnrotate) < 1e-9,
    `disagree by ${angleBetween(viaEyeDirection, viaUnrotate)} deg`);
});

test('vecToLatLon and latLonFromQuat agree on an eye direction', () => {
  const pose = quatFromLatLon(-48, 133);
  assert.deepEqual(vecToLatLon(eyeDirection(pose)), latLonFromQuat(pose));
});

test('a point picked past the limb -- pointAt\'s miss case -- is null before it ever reaches unrotate', () => {
  // pickCameraSphere with clampToLimb false (pointAt's whole reason for not
  // passing true) already returns null past the limb; this is that contract
  // read from pointAt's call site rather than re-derived.
  assert.equal(pickCameraSphere({ x: 0.9, y: 0.9 }, VIEW, false), null);
});

test('IDENTITY is a real quaternion and rotates nothing', () => {
  assert.equal(quatAngle(IDENTITY, IDENTITY), 0);
  const e = eyeDirection(IDENTITY);
  assert.ok(Math.abs(Math.hypot(e.x, e.y, e.z) - 1) < 1e-12);
});
