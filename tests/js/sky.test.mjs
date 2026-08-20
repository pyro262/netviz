import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gmstDegrees, starDirection, bvToRgb, GALACTIC_POLE, equatorialToVec,
  sampleBandDirection, bandFraction, equatorialToGalactic, vecToGalactic,
  GALACTIC_X, GALACTIC_Y, GALACTIC_Z,
} from '../../netviz/static/js/starfield.js';
import {
  MODEL, BRIGHT_CLOUDS, DARK_CLOUDS, SATELLITES, cloudGlsl,
} from '../../netviz/static/js/galaxy.js';

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

// ------------------------------------------------------------- galactic --
//
// The band is only ever as accurate as this transform. Every expectation
// below is the published J2000 galactic coordinate of a real object, and the
// tolerance is 0.01 deg -- far tighter than anything visible, because these
// are exact numbers and a frame that is merely close is a frame that has one
// axis subtly wrong.

const GAL_CASES = [
  ['Sgr A*', 266.41683, -29.00781, 359.944, -0.046],
  ['M31', 10.68471, 41.26875, 121.174, -21.573],
  ['Polaris', 37.95456, 89.26411, 123.281, 26.461],
  ['M42, the Orion Nebula', 83.82208, -5.39111, 209.014, -19.383],
  ['the Crab Nebula', 83.63308, 22.01450, 184.557, -5.784],
  ['the LMC', 80.894, -69.756, 280.465, -32.888],
];

test('equatorialToGalactic reproduces the published coordinates of real objects', () => {
  for (const [name, ra, dec, l, b] of GAL_CASES) {
    const [gl, gb] = equatorialToGalactic(ra, dec);
    assert.ok(Math.abs(gl - l) < 0.01, `${name}: l ${gl} not ${l}`);
    assert.ok(Math.abs(gb - b) < 0.01, `${name}: b ${gb} not ${b}`);
  }
});

test('the north galactic pole is at b = +90 and the plane at b = 0', () => {
  // 1e-3 deg, not 0: the three axes come from published coordinates rounded
  // to five decimals, so the frame they span is orthonormal to about 0.0001
  // deg and no closer. That residual is four orders of magnitude below one
  // texel of the baked map and is the honest limit of the input numbers.
  assert.ok(Math.abs(vecToGalactic(GALACTIC_Z)[1] - 90) < 1e-3);
  assert.ok(Math.abs(vecToGalactic(GALACTIC_X)[1]) < 1e-3);
  assert.ok(Math.abs(vecToGalactic(GALACTIC_Y)[1]) < 1e-3);
  // The centre is l=0 and l=90 is l=90. This is the half that a cross-product
  // basis gets WRONG: equatorialToVec is a mirror, so a `Z x X` third axis
  // comes back with longitude running backwards -- which still puts the band
  // in the right place and still puts Sagittarius in the wrong one.
  assert.ok(Math.abs(vecToGalactic(GALACTIC_X)[0]) < 1e-3);
  assert.ok(Math.abs(vecToGalactic(GALACTIC_Y)[0] - 90) < 1e-3);
});

test('the galactic pole the band is drawn around is the one the stars use', () => {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(GALACTIC_Z[i] - GALACTIC_POLE[i]) < 1e-5);
  }
});

test('the galactic axes are an orthonormal frame', () => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const v of [GALACTIC_X, GALACTIC_Y, GALACTIC_Z]) {
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-9);
  }
  assert.ok(Math.abs(dot(GALACTIC_X, GALACTIC_Y)) < 1e-4);
  assert.ok(Math.abs(dot(GALACTIC_X, GALACTIC_Z)) < 1e-4);
  assert.ok(Math.abs(dot(GALACTIC_Y, GALACTIC_Z)) < 1e-4);
});

// ------------------------------------------------------- the galaxy model --

test('every modeled cloud is a real object at a plausible galactic coordinate', () => {
  for (const c of [...BRIGHT_CLOUDS, ...DARK_CLOUDS, ...SATELLITES]) {
    assert.ok(c.l >= 0 && c.l < 360, `${c.name}: l out of range`);
    assert.ok(Math.abs(c.b) <= 90, `${c.name}: b out of range`);
    assert.ok(c.sl > 0 && c.sb > 0 && c.amp > 0, `${c.name}: degenerate`);
    assert.ok(c.name.length > 3, 'a cloud with no name is a cloud nobody can check');
  }
});

test('the band clouds sit ON the band, and only the satellites are allowed off it', () => {
  // Everything in the two band tables is within 20 deg of the plane, which is
  // what makes them features OF the Milky Way rather than patches painted on
  // the sky. The Magellanic Clouds are 33 and 44 deg off it -- they are in a
  // separate table for exactly that reason, and this is the assertion that
  // stops one being quietly moved into the band's.
  for (const c of [...BRIGHT_CLOUDS, ...DARK_CLOUDS]) {
    assert.ok(Math.abs(c.b) <= 20, `${c.name} is ${c.b} deg off the plane`);
  }
  for (const c of SATELLITES) assert.ok(Math.abs(c.b) > 25, `${c.name} is on the band`);
});

test('the dust layer is far thinner than the stars, which is what makes a rift', () => {
  // Not taste and not tuning: the dark lane down the middle of the band
  // exists because dust has a ~75 pc scale height and the stars a ~300 pc
  // one. Invert this and the model has no rift to draw.
  assert.ok(MODEL.dustHZ < MODEL.thinHZ / 3);
  assert.ok(MODEL.Z0 > 0 && MODEL.Z0 < 0.1);      // the Sun is just above it
  assert.ok(MODEL.losMax > 2 * MODEL.R0);         // reaches the far disk edge
});

test('extinction reddens: A_B > A_V > A_R, or the Galactic centre comes out blue', () => {
  assert.ok(MODEL.extB > MODEL.extG && MODEL.extG > MODEL.extR);
});

test('the generated GLSL carries every cloud in the table exactly once', () => {
  const src = cloudGlsl('brightClouds', BRIGHT_CLOUDS);
  assert.match(src, /^float brightClouds\(float l, float b\) \{/);
  assert.equal(src.split('g(l, b,').length - 1, BRIGHT_CLOUDS.length);
  for (const c of BRIGHT_CLOUDS) {
    assert.ok(src.includes(c.l.toFixed(1)), `${c.name} lost its longitude`);
  }
});
