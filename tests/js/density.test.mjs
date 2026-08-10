// Block arcs blend additively, so a WeChat burst -- a dozen blocks to China on
// one corridor -- sums into a glare that a single arc never shows. Blocks are
// never dropped, so the count cannot be capped; the brightness is dimmed
// instead, and that dimming has to be a measurable function rather than a
// value tuned against one screenshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { densityGain, DENSITY } from '../../netviz/static/js/density.js';

test('a handful of arcs is left exactly alone', () => {
  for (let n = 0; n <= DENSITY.ref; n += 1) {
    assert.equal(densityGain(n), 1, `${n} arcs was dimmed`);
  }
});

test('gain falls once the arcs pile up', () => {
  assert.ok(densityGain(DENSITY.ref + 1) < 1);
  assert.ok(densityGain(20) < densityGain(10));
});

test('gain never falls below the floor, however big the burst', () => {
  for (const n of [30, 100, 220]) {
    assert.ok(densityGain(n) >= DENSITY.floor, `${n} arcs went below the floor`);
  }
});

test('gain is monotonic, so brightness never jumps back up', () => {
  let prev = 1;
  for (let n = 1; n <= 300; n += 1) {
    const g = densityGain(n);
    assert.ok(g <= prev + 1e-12, `gain rose at n=${n}`);
    prev = g;
  }
});

test('total brightness is flat while the gain has headroom', () => {
  // n * gain is the additive sum on screen. Between ref and ref/floor it must
  // stay at ref -- that is the whole point of the change.
  const flatTo = Math.round(DENSITY.ref / DENSITY.floor);
  for (let n = DENSITY.ref; n <= flatTo; n += 1) {
    assert.ok(Math.abs(n * densityGain(n) - DENSITY.ref) < 1e-9,
      `total at n=${n} was ${n * densityGain(n)}, wanted ${DENSITY.ref}`);
  }
  // Past the floor it climbs again, but at a quarter rate: a 30-arc burst still
  // reads as busier than a 16-arc one, just not four times brighter.
  assert.ok(30 * densityGain(30) > flatTo * densityGain(flatTo));
  assert.ok(30 * densityGain(30) < 30);
});
