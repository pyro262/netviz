import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampDistance, zoomBy, decay, validateZoomRange,
} from '../../netviz/static/js/orbit.js';

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

test('clampDistance propagates a missing bound as NaN -- which is why the guard exists', () => {
  // Not a wish: `input.zoomRange` reaches this from a settings patch, and NaN
  // here becomes a NaN camera.position and a black display with a silent
  // console. Asserted so nobody "simplifies" validateZoomRange away later.
  assert.ok(Number.isNaN(clampDistance(4.6, 3.3, undefined)));
  assert.ok(Number.isNaN(clampDistance(4.6, undefined, 9.0)));
});

test('validateZoomRange passes the shipped pair through unchanged', () => {
  assert.deepEqual(validateZoomRange(3.3, 9.0), [3.3, 9.0]);
});

test('validateZoomRange refuses anything that would NaN the camera', () => {
  assert.throws(() => validateZoomRange(3.3, undefined), /two finite numbers/);
  assert.throws(() => validateZoomRange(undefined, 9.0), /two finite numbers/);
  assert.throws(() => validateZoomRange(3.3, NaN), /two finite numbers/);
  assert.throws(() => validateZoomRange('3.3', 9.0), /two finite numbers/);
});

test('validateZoomRange holds the limb-clip floor, which is not taste', () => {
  // Below ~3.2 radii the globe's angular radius exceeds the 17.5 deg half-FOV
  // of the 35 deg camera and the limb clips on a 16:9 wall.
  assert.throws(() => validateZoomRange(1.0, 9.0), /below 3.3/);
  assert.throws(() => validateZoomRange(3.29, 9.0), /below 3.3/);
  assert.deepEqual(validateZoomRange(3.3, 9.0), [3.3, 9.0]);
});

test('validateZoomRange refuses a reversed or degenerate pair rather than sorting it', () => {
  // Guessing which end was meant is how a control starts lying.
  assert.throws(() => validateZoomRange(9.0, 3.3), /not below/);
  assert.throws(() => validateZoomRange(4.6, 4.6), /not below/);
});
