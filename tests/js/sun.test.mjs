// Run: node --test tests/js/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subsolarPoint, sunDirection } from '../../netviz/static/js/sun.js';

test('june solstice puts the sun over the tropic of cancer', () => {
  const { lat } = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  assert.ok(Math.abs(lat - 23.44) < 0.2, `expected ~23.44, got ${lat}`);
});

test('december solstice puts the sun over the tropic of capricorn', () => {
  const { lat } = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
  assert.ok(Math.abs(lat + 23.44) < 0.2, `expected ~-23.44, got ${lat}`);
});

test('march equinox puts the sun near the equator', () => {
  const { lat } = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(lat) < 0.6, `expected ~0, got ${lat}`);
});

test('at 12:00 UTC the sun is near the prime meridian', () => {
  const { lon } = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(lon) < 4, `expected ~0, got ${lon}`);
});

test('the subsolar longitude advances about 15 degrees per hour westward', () => {
  const a = subsolarPoint(new Date('2026-03-20T12:00:00Z')).lon;
  const b = subsolarPoint(new Date('2026-03-20T13:00:00Z')).lon;
  let d = a - b;
  if (d < -180) d += 360;
  assert.ok(Math.abs(d - 15) < 0.3, `expected ~15, got ${d}`);
});

test('sunDirection is a unit vector consistent with the subsolar point', () => {
  const date = new Date('2026-03-20T12:00:00Z');
  const { lat, lon } = subsolarPoint(date);
  const v = sunDirection(date);

  const len = Math.hypot(v.x, v.y, v.z);
  assert.ok(Math.abs(len - 1) < 1e-9, `expected unit length, got ${len}`);

  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = (-lon * Math.PI) / 180;   // frame: theta = -lon, see globe.js
  assert.ok(Math.abs(v.x - Math.sin(phi) * Math.cos(theta)) < 1e-9);
  assert.ok(Math.abs(v.y - Math.cos(phi)) < 1e-9);
  assert.ok(Math.abs(v.z - Math.sin(phi) * Math.sin(theta)) < 1e-9);
});
