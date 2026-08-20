import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dipoleAxis, magneticFrame, ovalEdge, ovalThickness, raySphere, marchSpan,
  ovalBrightness, PEAK_MLT, DAY_FLOOR,
} from '../../netviz/static/js/auroral_oval.js';

/** globe.js's convention, restated here so a change to either is caught. */
function latLonToVec3(lat, lon) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((-lon) * Math.PI) / 180;
  return { x: Math.sin(phi) * Math.cos(theta),
           y: Math.cos(phi),
           z: Math.sin(phi) * Math.sin(theta) };
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const deg = (r) => (r * 180) / Math.PI;

test('the dipole axis IS the geomagnetic pole, in the globe convention', () => {
  const a = dipoleAxis();
  const p = latLonToVec3(80.7, -72.7);
  assert.ok(Math.abs(dot(a, p) - 1) < 1e-12,
    'a +lon axis would sit 145 degrees of longitude away and look plausible');
});

test('the geographic north pole is 9.3 degrees of magnetic colatitude away', () => {
  const f = magneticFrame(latLonToVec3(90, 0), dipoleAxis(), { x: 1, y: 0, z: 0 });
  assert.equal(f.hemi, 1);
  assert.ok(Math.abs(f.colat - 9.3) < 0.05, `got ${f.colat}`);
});

test('the southern oval is measured from the antipode, not from the north', () => {
  const f = magneticFrame(latLonToVec3(-80.7, 107.3), dipoleAxis(), { x: 1, y: 0, z: 0 });
  assert.equal(f.hemi, -1);
  assert.ok(f.colat < 0.001, `the south magnetic pole must read colat 0, got ${f.colat}`);
});

test('magnetic local time is 0 on the anti-solar magnetic meridian', () => {
  const axis = dipoleAxis();
  const sun = { x: 1, y: 0, z: 0 };
  // Walk a ring of magnetic colatitude 20 and find the minimum-MLT point;
  // it must be the one furthest from the sun.
  let best = null;
  for (let i = 0; i < 720; i += 1) {
    const lon = -180 + i * 0.5;
    for (const lat of [50, 55, 60, 65, 70]) {
      const n = latLonToVec3(lat, lon);
      const f = magneticFrame(n, axis, sun);
      if (Math.abs(f.colat - 20) > 0.6) continue;
      const s = dot(n, sun);
      if (!best || s < best.s) best = { s, mlt: f.mlt };
    }
  }
  assert.ok(best, 'the sweep found no point at colatitude 20');
  const wrapped = Math.min(best.mlt, 24 - best.mlt);
  assert.ok(wrapped < 0.4, `darkest point on the ring reads MLT ${best.mlt}`);
});

test('mlt runs 0..24 and noon is opposite midnight', () => {
  const axis = dipoleAxis();
  const sun = { x: 1, y: 0, z: 0 };
  for (let i = 0; i < 200; i += 1) {
    const n = latLonToVec3(-80 + i * 0.8, -170 + i * 1.7);
    const f = magneticFrame(n, axis, sun);
    assert.ok(f.mlt >= 0 && f.mlt < 24, `mlt out of range: ${f.mlt}`);
  }
});

test('at magnetic noon the edge is EXACTLY the collector formula', () => {
  for (const kp of [0, 1, 2.33, 5, 9]) {
    assert.ok(Math.abs(ovalEdge(kp, 12) - (66.5 - 1.7 * kp)) < 1e-9,
      'the display and the collector must agree on the quiet-sun edge');
  }
});

test('the oval reaches further equatorward at magnetic midnight', () => {
  assert.ok(ovalEdge(3, 0) < ovalEdge(3, 12) - 3.0,
    'midnight must be at least 3 degrees lower in latitude than noon');
  assert.ok(Math.abs(ovalEdge(3, 0) - (ovalEdge(3, 12) - 4.0)) < 1e-9);
});

test('the edge is continuous across the midnight wrap', () => {
  assert.ok(Math.abs(ovalEdge(4, 23.999) - ovalEdge(4, 0)) < 1e-3,
    'a seam at MLT 24->0 draws a visible notch through the brightest sector');
});

test('the edge falls monotonically with kp at every local time', () => {
  for (const mlt of [0, 3, 6, 12, 18, 21]) {
    for (let kp = 0; kp < 9; kp += 0.5) {
      assert.ok(ovalEdge(kp + 0.5, mlt) < ovalEdge(kp, mlt));
    }
  }
});

test('kp is clamped to the published 0..9 scale', () => {
  assert.equal(ovalEdge(-3, 12), ovalEdge(0, 12));
  assert.equal(ovalEdge(40, 12), ovalEdge(9, 12));
});

test('the band is thickest at midnight and thinnest at noon', () => {
  assert.ok(ovalThickness(0) > ovalThickness(12));
  assert.ok(Math.abs(ovalThickness(0) - 1.6) < 1e-9);
  assert.ok(Math.abs(ovalThickness(12) - 1.0) < 1e-9);
  assert.ok(Math.abs(ovalThickness(23.999) - ovalThickness(0)) < 1e-3);
});

test('raySphere finds both roots of a ray straight through the middle', () => {
  const r = raySphere({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, 1);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.t0 - 4) < 1e-9);
  assert.ok(Math.abs(r.t1 - 6) < 1e-9);
});

test('raySphere misses cleanly', () => {
  assert.equal(raySphere({ x: 0, y: 0, z: 5 }, { x: 0, y: 1, z: 0 }, 1).hit, false);
});

test('a ray through the planet is clipped at the planet, not behind it', () => {
  // Straight down the barrel: outer shell entered at 5-1.05, planet at 5-1.
  const s = marchSpan({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, 1, 1.016, 1.05);
  assert.ok(Math.abs(s.start - (5 - 1.05)) < 1e-9);
  assert.ok(Math.abs(s.end - (5 - 1.0)) < 1e-9,
    'sampling past the planet paints the far-side oval THROUGH the Earth');
});

test('a limb ray keeps its WHOLE chord, unclipped by the planet', () => {
  // Offset so it clears the globe but still crosses the shell twice. The
  // property is that nothing is clipped away, NOT that the span is long: the
  // shell is only 0.05 radii thick, so a ray at impact parameter 1.03 has a
  // chord of 2*sqrt(1.05^2 - 1.03^2) = 0.408 and no ray that clears a planet of
  // radius 1 can do better than 0.64. An earlier draft of this test asserted
  // `> 1.0`, which is geometrically impossible for any ray this case describes.
  const ro = { x: 0, y: 1.03, z: 5 };
  const rd = { x: 0, y: 0, z: -1 };
  const s = marchSpan(ro, rd, 1, 1.016, 1.05);
  const outer = raySphere(ro, rd, 1.05);
  assert.ok(s, 'the limb view is the one this whole task exists for');
  assert.ok(Math.abs((s.end - s.start) - (outer.t1 - outer.t0)) < 1e-12,
    'the planet clipped a ray that never touches it');
  assert.ok(s.end - s.start > 0.3, `chord ${(s.end - s.start).toFixed(3)} is too short to march`);
});

test('a ray that misses the shell entirely gets no span', () => {
  assert.equal(marchSpan({ x: 0, y: 9, z: 5 }, { x: 0, y: 0, z: -1 }, 1, 1.016, 1.05), null);
});

test('a camera inside the shell never marches backwards', () => {
  const s = marchSpan({ x: 0, y: 0, z: 1.03 }, { x: 0, y: 1, z: 0 }, 1, 1.016, 1.05);
  assert.ok(s.start >= 0, 'a negative start samples behind the eye');
});

// ---------------------------------------------------------------------------
// Brightness around the ring.
//
// The oval being a RING was always right -- that is the real morphology. What
// was wrong was drawing it EVENLY around that ring, which reads as a drawn
// circle rather than as aurora.

test('the oval is brightest just after magnetic midnight, not at noon', () => {
  assert.ok(ovalBrightness(PEAK_MLT) > ovalBrightness(12) * 5,
    'the midnight sector must dominate the dayside, not merely beat it');
  assert.ok(ovalBrightness(0) > ovalBrightness(6));
  assert.ok(ovalBrightness(6) > ovalBrightness(12));
});

test('the peak sits toward DAWN of midnight, where substorms break up', () => {
  // Sampled finely rather than asserted at one point: the claim is about where
  // the maximum IS, and checking only PEAK_MLT would pass for any function
  // whose peak happens to be somewhere else entirely.
  let best = { mlt: null, v: -1 };
  for (let i = 0; i < 2400; i += 1) {
    const mlt = (i / 100) % 24;
    const v = ovalBrightness(mlt);
    if (v > best.v) best = { mlt, v };
  }
  assert.ok(Math.abs(best.mlt - PEAK_MLT) < 0.05, `peak at MLT ${best.mlt}`);
  assert.ok(PEAK_MLT > 0 && PEAK_MLT < 3, 'the peak is just after midnight');
});

test('the dayside keeps a floor rather than going dark', () => {
  // The cusp aurora is real and continuous with the rest of the ring; it is
  // faint, and DAYLIGHT is what finishes it off -- which is the shader's night
  // gate, a separate term. A hard zero here would put a seam in the ring.
  for (let mlt = 0; mlt < 24; mlt += 0.25) {
    assert.ok(ovalBrightness(mlt) >= DAY_FLOOR - 1e-9, `dark at MLT ${mlt}`);
    assert.ok(ovalBrightness(mlt) <= 1 + 1e-9, `over unity at MLT ${mlt}`);
  }
});

test('brightness is continuous across the midnight wrap', () => {
  assert.ok(Math.abs(ovalBrightness(23.999) - ovalBrightness(0)) < 1e-3,
    'a seam at MLT 24->0 would draw a notch through the brightest sector');
  assert.ok(Math.abs(ovalBrightness(-1) - ovalBrightness(23)) < 1e-9,
    'a negative hour must wrap rather than fall off the end');
});

test('brightness and the edge are separate facts about the same ring', () => {
  // ovalEdge and ovalThickness peak at MIDNIGHT exactly; brightness peaks a
  // little after. Asserted so a future edit cannot quietly collapse the three
  // into one term -- they are different physics.
  assert.ok(Math.abs(ovalEdge(3, 0) - ovalEdge(3, PEAK_MLT)) > 1e-6);
});
