import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gmstDegrees, starDirection, bvToRgb, GALACTIC_POLE, equatorialToVec,
  sampleBandDirection, bandFraction,
} from '../../netviz/static/js/starfield.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const utc = (s) => new Date(s);
const deg = (r) => (r * 180) / Math.PI;

test('GMST at J2000.0 epoch is about 18.697 hours', () => {
  const g = gmstDegrees(utc('2000-01-01T12:00:00Z'));
  assert.ok(Math.abs(g - 18.697374558 * 15) < 0.01, `got ${g}`);
});

test('GMST advances about 15.041 degrees per hour', () => {
  const a = gmstDegrees(utc('2026-06-01T00:00:00Z'));
  const b = gmstDegrees(utc('2026-06-01T01:00:00Z'));
  let d = b - a;
  if (d < 0) d += 360;
  assert.ok(Math.abs(d - 15.04107) < 0.001, `got ${d}`);
});

test('Polaris sits within a degree of the north celestial pole, always', () => {
  // RA 2h31m49s = 37.95 deg, Dec +89.264. Whatever the time, it must stay at +Y.
  for (const t of ['2026-01-01T00:00:00Z', '2026-07-04T18:00:00Z', '2027-03-03T09:00:00Z']) {
    const v = starDirection(37.95, 89.264, utc(t));
    const lat = deg(Math.asin(v[1]));
    assert.ok(lat > 89, `Polaris drifted to lat ${lat} at ${t}`);
  }
});

test('a star on the celestial equator stays on the equator', () => {
  const v = starDirection(83.0, 0, utc('2026-02-02T02:02:00Z'));
  assert.ok(Math.abs(v[1]) < 1e-9, `y = ${v[1]}`);
});

test('a star culminates over longitude 0 when its RA equals GMST', () => {
  const t = utc('2026-09-09T09:09:00Z');
  const ra = gmstDegrees(t);
  const v = starDirection(ra, 0, t);
  // Scene frame uses theta = -lon, so lon 0 is +X.
  assert.ok(v[0] > 0.999999, `not over the prime meridian: ${v}`);
});

test('the sky turns westward, a full turn per sidereal day', () => {
  const t0 = utc('2026-04-04T00:00:00Z');
  const a = starDirection(100, 0, t0);
  const b = starDirection(100, 0, new Date(t0.getTime() + 3600000));
  const lonA = -deg(Math.atan2(a[2], a[0]));
  const lonB = -deg(Math.atan2(b[2], b[0]));
  let d = lonB - lonA;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  assert.ok(d < -14.9 && d > -15.2, `expected ~-15.04 deg/hour, got ${d}`);
});

test('star directions are unit vectors', () => {
  const v = equatorialToVec(123.4, -56.7);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
});

test('the galactic pole is the real one: RA 192.86, Dec 27.13', () => {
  const expected = equatorialToVec(192.859508, 27.128336);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(GALACTIC_POLE[i] - expected[i]) < 1e-9);
  }
});

test('B-V maps blue stars blue and red stars red', () => {
  const rigel = bvToRgb(-0.03);     // hot blue-white
  const betelgeuse = bvToRgb(1.85); // cool red
  assert.ok(rigel[2] >= rigel[0], 'hot star should not be red-dominant');
  assert.ok(betelgeuse[0] > betelgeuse[2], 'cool star should be red-dominant');
});

test('B-V output stays in range for extreme and missing values', () => {
  for (const ci of [-5, -0.4, 0, 1, 2, 6]) {
    for (const c of bvToRgb(ci)) {
      assert.ok(c >= 0 && c <= 1, `channel out of range for ci=${ci}: ${c}`);
    }
  }
});

test('band-sampled directions are unit vectors', () => {
  const rng = mulberry32(9);
  for (let i = 0; i < 200; i += 1) {
    const v = sampleBandDirection(rng, 0.8);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  }
});

test('no bias reproduces a uniform sphere', () => {
  // 25.9% of a uniform sphere lies within 15 degrees of any great circle.
  const rng = mulberry32(10);
  const d = Array.from({ length: 4000 }, () => sampleBandDirection(rng, 0));
  const f = bandFraction(d, 15);
  assert.ok(f > 0.21 && f < 0.31, `expected ~0.26, got ${f}`);
});

test('the bias really concentrates points on the plane', () => {
  const rng = mulberry32(11);
  const d = Array.from({ length: 4000 }, () => sampleBandDirection(rng, 0.85));
  assert.ok(bandFraction(d, 15) > 0.6, `band too thin: ${bandFraction(d, 15)}`);
});

test('even a heavy bias leaves stars at the galactic poles', () => {
  const rng = mulberry32(12);
  const d = Array.from({ length: 4000 }, () => sampleBandDirection(rng, 0.85));
  const away = d.length - d.filter((v) => bandFraction([v], 40) === 1).length;
  assert.ok(away > 100, `sky outside the band is empty: ${away}`);
});
