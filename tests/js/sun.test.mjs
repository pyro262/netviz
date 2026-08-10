// Run: node --test tests/js/
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  subsolarPoint, sunDirection, sunAltitude, dayFraction,
} from '../../netviz/static/js/sun.js';

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

// --- daylight ramp for the star brightness ----------------------------------
//
// A kiosk in a lit room needs the stars driven harder by day. None of this can
// be judged by watching: the interesting moments are twelve hours apart.

describe('sunAltitude', () => {
  it('puts the sun overhead at the subsolar point', () => {
    const d = new Date('2026-06-21T12:00:00Z');
    const { lat, lon } = subsolarPoint(d);
    assert.ok(Math.abs(sunAltitude(d, lat, lon) - 90) < 0.5);
  });

  it('puts the sun underfoot at the antipode', () => {
    const d = new Date('2026-06-21T12:00:00Z');
    const { lat, lon } = subsolarPoint(d);
    const anti = sunAltitude(d, -lat, lon > 0 ? lon - 180 : lon + 180);
    assert.ok(Math.abs(anti + 90) < 0.5, `got ${anti}`);
  });

  it('is above the horizon at local noon and below at local midnight', () => {
    // 30N 95W: local noon is about 18:20 UTC.
    assert.ok(sunAltitude(new Date('2026-03-20T18:20:00Z'), 30, -95) > 50);
    assert.ok(sunAltitude(new Date('2026-03-20T06:20:00Z'), 30, -95) < -50);
  });

  it('is near zero at an almanac sunrise', () => {
    // Equinox at 30N: sunrise is within a few minutes of 06:00 local, and
    // 95W is 6h20m behind UTC.
    const alt = sunAltitude(new Date('2026-03-20T12:20:00Z'), 30, -95);
    assert.ok(Math.abs(alt) < 2, `expected near the horizon, got ${alt}`);
  });
});

describe('dayFraction', () => {
  const LAT = 30, LON = -95;

  it('is 1 in the middle of the day and 0 in the middle of the night', () => {
    assert.equal(dayFraction(new Date('2026-03-20T18:20:00Z'), LAT, LON), 1);
    assert.equal(dayFraction(new Date('2026-03-20T06:20:00Z'), LAT, LON), 0);
  });

  it('starts the climb at sunrise, not before it', () => {
    // Half an hour before the crossing the sky is still fully night.
    assert.equal(dayFraction(new Date('2026-03-20T11:45:00Z'), LAT, LON), 0);
  });

  it('reaches full day a ramp after sunrise', () => {
    // Geometric sunrise here is 12:28 UTC, not the 12:20 a naive
    // six-hours-behind-UTC guess gives -- worth pinning, since an assumed
    // sunrise time is exactly how this test first failed.
    const f = dayFraction(new Date('2026-03-20T12:59:00Z'), LAT, LON, 30);
    assert.equal(f, 1);
  });

  it('is part way up midway through the morning ramp', () => {
    const f = dayFraction(new Date('2026-03-20T12:43:00Z'), LAT, LON, 30);
    assert.ok(f > 0.2 && f < 0.8, `expected mid-ramp, got ${f}`);
  });

  it('takes the configured ramp to cross, not longer', () => {
    // The contract the user asked for: 30 minutes from the crossing to full
    // brightness. The rate is sampled forward from `now`, and the sun's climb
    // is not linear, so this is worth measuring rather than assuming.
    const at = (m) => dayFraction(new Date(Date.UTC(2026, 2, 20, 11, 30 + m)),
                                  LAT, LON, 30);
    let start = null, end = null;
    for (let m = 0; m < 200; m += 1) {
      if (start === null && at(m) > 0) start = m;
      if (start !== null && end === null && at(m) >= 1) end = m;
    }
    assert.ok(Math.abs((end - start) - 30) <= 2, `ramp took ${end - start} min`);
  });

  it('honours a different ramp length', () => {
    const at = (m, r) => dayFraction(new Date(Date.UTC(2026, 2, 20, 11, 30 + m)),
                                     LAT, LON, r);
    // 10 minutes after the 12:28 crossing: nearly there on a 15-minute ramp,
    // barely started on a 60-minute one.
    assert.ok(at(68, 15) > 0.6);
    assert.ok(at(68, 60) < 0.3);
  });

  it('is still full day at sunset and dark a ramp later', () => {
    // Equinox sunset at 95W is close to 00:20 UTC the next day.
    assert.ok(dayFraction(new Date('2026-03-21T00:15:00Z'), LAT, LON) > 0.9);
    assert.equal(dayFraction(new Date('2026-03-21T01:00:00Z'), LAT, LON), 0);
  });

  it('is monotonic across sunrise', () => {
    let prev = -1;
    for (let m = 0; m <= 90; m += 5) {
      const f = dayFraction(new Date(Date.UTC(2026, 2, 20, 11, 45 + m)), LAT, LON);
      assert.ok(f >= prev, `dipped at +${m}min: ${f} < ${prev}`);
      prev = f;
    }
  });

  it('never leaves [0, 1] anywhere on earth across a whole year', () => {
    for (const lat of [-89, -66, -30, 0, 30, 66, 89]) {
      for (let day = 0; day < 365; day += 7) {
        const d = new Date(Date.UTC(2026, 0, 1 + day, day % 24));
        const f = dayFraction(d, lat, 12);
        assert.ok(f >= 0 && f <= 1, `lat ${lat} day ${day}: ${f}`);
      }
    }
  });

  it('degenerates to its endpoints under a polar sun that barely moves', () => {
    // Midsummer at the pole: the sun circles at a near-constant altitude, so
    // there is no crossing to ramp through and the answer must still be day.
    assert.equal(dayFraction(new Date('2026-06-21T12:00:00Z'), 89.9, 0), 1);
    assert.equal(dayFraction(new Date('2026-12-21T12:00:00Z'), 89.9, 0), 0);
  });
});
