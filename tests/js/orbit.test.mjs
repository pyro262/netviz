import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latLonToUnit, unitToLatLon, pickSphere, solveDrag, clampDistance, zoomBy, decay,
} from '../../netviz/static/js/orbit.js';

const VIEW = { distance: 4.6, fovDeg: 35, aspect: 16 / 9 };

test('latLonToUnit matches the renderer sign convention', () => {
  // theta = -lon. East of Greenwich must have NEGATIVE z, or the globe mirrors.
  const east = latLonToUnit(0, 90);
  assert.ok(east.z < -0.99, `east z was ${east.z}`);
  const p = latLonToUnit(0, 0);
  assert.ok(Math.abs(p.x - 1) < 1e-9);
});

test('latLonToUnit and unitToLatLon round-trip', () => {
  for (const [lat, lon] of [[0, 0], [45, 30], [-30, -120], [60, 179], [-62, 90]]) {
    const back = unitToLatLon(latLonToUnit(lat, lon));
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${lat} -> ${back.lat}`);
    assert.ok(Math.abs(((back.lon - lon + 540) % 360) - 180) < 1e-6,
              `lon ${lon} -> ${back.lon}`);
  }
});

test('the screen centre hits the sphere at the camera lat/lon', () => {
  const hit = pickSphere(30, -95, VIEW.distance, 0, 0, VIEW.fovDeg, VIEW.aspect);
  const ll = unitToLatLon(hit);
  assert.ok(Math.abs(ll.lat - 30) < 1e-6, `lat ${ll.lat}`);
  assert.ok(Math.abs(ll.lon - -95) < 1e-6, `lon ${ll.lon}`);
});

test('a ray past the limb misses', () => {
  assert.equal(pickSphere(0, 0, 4.6, 0.99, 0.99, 35, 16 / 9), null);
});

test('a ray inside the limb hits', () => {
  assert.notEqual(pickSphere(0, 0, 4.6, 0.1, 0.1, 35, 16 / 9), null);
});

test('solveDrag puts the grabbed point back under the pointer', () => {
  // Grab at screen centre, move the pointer up and right, and check the
  // grabbed point lands under the new pointer position. Every case here has a
  // solution the camera can actually hold; the clamp case is tested below.
  for (const [lat, lon] of [[0, 0], [40, -74], [-35, 150], [20, 100]]) {
    const grab = pickSphere(lat, lon, VIEW.distance, 0, 0, VIEW.fovDeg, VIEW.aspect);
    const ndc = { x: 0.25, y: 0.18 };
    const cam = solveDrag({ lat, lon }, grab, ndc, VIEW);
    const landed = pickSphere(cam.lat, cam.lon, VIEW.distance,
                              ndc.x, ndc.y, VIEW.fovDeg, VIEW.aspect);
    assert.notEqual(landed, null, 'grabbed point fell off the globe');
    const a = unitToLatLon(landed);
    const b = unitToLatLon(grab);
    const dLat = a.lat - b.lat;
    const dLon = ((a.lon - b.lon + 540) % 360) - 180;
    const err = Math.hypot(dLat, dLon * Math.cos(a.lat * Math.PI / 180));
    assert.ok(err < 1.0, `from ${lat},${lon}: error ${err.toFixed(3)} deg`);
  }
});

test('a drag whose solution is past the clamp stops at the clamp', () => {
  // Not a failure: the grabbed point genuinely cannot stay under the pointer
  // when holding it there would need a camera latitude the display never
  // adopts. What must not happen is divergence -- the unguarded iteration
  // walked this case to latitude -430, past the pole, frame flipping on the
  // way.
  for (const [lat, lon] of [[58, 12], [-62, 150]]) {
    const grab = pickSphere(lat, lon, VIEW.distance, 0, 0, VIEW.fovDeg, VIEW.aspect);
    const cam = solveDrag({ lat, lon }, grab, { x: 0.25, y: 0.18 }, VIEW);
    assert.ok(Number.isFinite(cam.lat) && Number.isFinite(cam.lon),
              `diverged to ${cam.lat},${cam.lon}`);
    assert.ok(Math.abs(cam.lat) <= 62 + 1e-9, `escaped the clamp: ${cam.lat}`);
    assert.ok(cam.lon >= -180 && cam.lon < 180, `lon unwrapped: ${cam.lon}`);
  }
});

test('solveDrag holds accuracy near the limb', () => {
  // 0.30 NDC is 9.6 deg off axis; the globe's angular radius at 4.6 radii is
  // 12.56 deg, so this is near the limb and still on it. 0.6 would be 18.6 deg
  // and miss the globe entirely -- the horizontal half-FOV is 29 deg, which is
  // much wider than the globe.
  const grab = pickSphere(0, 0, VIEW.distance, 0.30, 0.0, VIEW.fovDeg, VIEW.aspect);
  assert.notEqual(grab, null, 'test setup: 0.30 should still be on the globe');
  const ndc = { x: 0.12, y: 0.0 };
  const cam = solveDrag({ lat: 0, lon: 0 }, grab, ndc, VIEW);
  const landed = pickSphere(cam.lat, cam.lon, VIEW.distance,
                            ndc.x, ndc.y, VIEW.fovDeg, VIEW.aspect);
  const a = unitToLatLon(landed);
  const b = unitToLatLon(grab);
  const err = Math.hypot(a.lat - b.lat, ((a.lon - b.lon + 540) % 360) - 180);
  assert.ok(err < 1.0, `limb error ${err.toFixed(3)} deg`);
});

test('clampDistance keeps the limb out of trouble', () => {
  assert.equal(clampDistance(2.0, 3.3, 9.0), 3.3);
  assert.equal(clampDistance(50, 3.3, 9.0), 9.0);
  assert.equal(clampDistance(4.6, 3.3, 9.0), 4.6);
});

test('zoomBy is multiplicative and clamped', () => {
  const closer = zoomBy(4.6, -1, 1.1, 3.3, 9.0);
  assert.ok(closer < 4.6, 'negative notches move closer');
  const further = zoomBy(4.6, 1, 1.1, 3.3, 9.0);
  assert.ok(further > 4.6, 'positive notches move away');
  assert.equal(zoomBy(3.4, -100, 1.1, 3.3, 9.0), 3.3);
  assert.equal(zoomBy(8.9, 100, 1.1, 3.3, 9.0), 9.0);
});

test('zoom steps are symmetric in and out', () => {
  const there = zoomBy(4.6, -1, 1.1, 3.3, 9.0);
  const back = zoomBy(there, 1, 1.1, 3.3, 9.0);
  assert.ok(Math.abs(back - 4.6) < 1e-9, `round trip landed at ${back}`);
});

test('decay is frame-rate independent', () => {
  // One 0.1s step must equal ten 0.01s steps, or inertia depends on frame rate.
  const one = decay(100, 0.85, 0.1);
  let many = 100;
  for (let i = 0; i < 10; i++) many = decay(many, 0.85, 0.01);
  assert.ok(Math.abs(one - many) < 1e-9, `${one} vs ${many}`);
});

test('decay reaches zero and stays there', () => {
  // 0.85 per second reaches the 1e-6 snap-to-zero floor from 100 at about
  // 113 simulated seconds; 3000 steps of 0.05 is 150s, comfortably past it.
  let v = 100;
  for (let i = 0; i < 3000; i++) v = decay(v, 0.85, 0.05);
  assert.equal(v, 0, `settled at ${v}`);
});
