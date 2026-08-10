// A burst of blocks from one country is the most interesting thing the wall
// can show, and it is what makes the camera detour. A single stray block is
// not: the threshold is what keeps the camera from being yanked around.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBurstDetector, BURST } from '../../netviz/static/js/burst.js';

/** Feed n blocks from `cc` at one-second intervals starting at t0. */
function feed(det, cc, n, t0, step = 1, lat = 30, lon = 110) {
  let hit = null;
  for (let i = 0; i < n; i += 1) {
    const r = det.add(cc, lat, lon, t0 + i * step);
    if (r) hit = r;
  }
  return hit;
}

test('one short of the threshold does not fire', () => {
  const det = createBurstDetector();
  assert.equal(feed(det, 'CN', BURST.count - 1, 0), null);
});

test('the threshold inside the window fires', () => {
  const det = createBurstDetector();
  const hit = feed(det, 'CN', BURST.count, 0);
  assert.ok(hit, 'a burst did not fire');
  assert.equal(hit.country, 'CN');
});

test('the same blocks spread beyond the window do not fire', () => {
  const det = createBurstDetector();
  const step = (BURST.windowSeconds / BURST.count) * 2;   // too slow to count
  assert.equal(feed(det, 'CN', BURST.count, 0, step), null);
});

test('a country cannot re-trigger until its cooldown expires', () => {
  const det = createBurstDetector();
  assert.ok(feed(det, 'CN', BURST.count, 0));
  assert.equal(feed(det, 'CN', BURST.count, 10), null, 'fired inside the cooldown');
  assert.ok(feed(det, 'CN', BURST.count, BURST.cooldownSeconds + 20),
    'never fired again after the cooldown');
});

test('countries are counted independently', () => {
  const det = createBurstDetector();
  // Neither country reaches the threshold on its own, though between them they
  // are well past it.
  for (let i = 0; i < BURST.count - 1; i += 1) {
    assert.equal(det.add('CN', 30, 110, i * 0.1), null, 'CN fired one short');
    assert.equal(det.add('RU', 55, 37, i * 0.1), null, 'RU fired one short');
  }
  // One more from RU alone tips RU, and only RU.
  const hit = det.add('RU', 55, 37, 1.1);
  assert.ok(hit, 'RU should have fired on its own count');
  assert.equal(hit.country, 'RU');
});

test('a block with no country is ignored rather than lumped together', () => {
  const det = createBurstDetector();
  for (let i = 0; i < BURST.count * 2; i += 1) {
    assert.equal(det.add(null, 0, 0, i * 0.1), null);
  }
});

test('the reported point is the mean of the burst origins', () => {
  const det = createBurstDetector();
  let hit = null;
  for (let i = 0; i < BURST.count; i += 1) {
    hit = det.add('CN', 30 + i, 110 + i, i * 0.1) || hit;
  }
  assert.ok(Math.abs(hit.lat - 32) < 0.5, `lat ${hit.lat}`);
  assert.ok(Math.abs(hit.lon - 112) < 0.5, `lon ${hit.lon}`);
});

test('the mean survives the antimeridian', () => {
  // Averaging lat/lon numerically would put a Fiji burst on the Greenwich
  // meridian -- the same wrap bug the camera centroid avoids by averaging
  // vectors.
  const det = createBurstDetector();
  let hit = null;
  const lons = [179, -179, 178, -178, 180];
  for (let i = 0; i < lons.length; i += 1) {
    hit = det.add('FJ', -17, lons[i], i * 0.1) || hit;
  }
  assert.ok(Math.abs(Math.abs(hit.lon) - 180) < 2, `lon ${hit.lon} is not near the seam`);
});

test('a fired burst starts counting again from empty', () => {
  // Otherwise one long burst re-fires on every event once the cooldown lapses,
  // which is a different thing from a fresh burst.
  const det = createBurstDetector();
  assert.ok(feed(det, 'CN', BURST.count, 0));
  const t = BURST.cooldownSeconds + 5;
  assert.equal(det.add('CN', 30, 110, t), null, 'refired on a single event');
});
