import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay, auroraFromReading } from '../../netviz/static/js/schedule.js';

const H = 3600_000;
const PERIOD = 3 * H;
const OFFSET = 6 * 60_000;      // 6 minutes past the boundary

const at = (iso) => new Date(iso).getTime();

test('fires just after the next 3-hour boundary', () => {
  const now = at('2026-08-09T01:10:00Z');
  const fires = new Date(now + nextPollDelay(now, PERIOD, OFFSET));
  assert.equal(fires.getUTCHours(), 3);
  assert.equal(fires.getUTCMinutes(), 6);
});

test('just past a firing time waits for the next boundary, not a hot loop', () => {
  const now = at('2026-08-09T03:07:00Z');
  const fires = new Date(now + nextPollDelay(now, PERIOD, OFFSET));
  assert.equal(fires.getUTCHours(), 6);
  assert.equal(fires.getUTCMinutes(), 6);
});

test('the delay is never zero or negative, at any minute of the day', () => {
  for (let m = 0; m < 24 * 60; m += 1) {
    const now = at('2026-08-09T00:00:00Z') + m * 60_000;
    const d = nextPollDelay(now, PERIOD, OFFSET);
    assert.ok(d > 0 && d <= PERIOD, `minute ${m} gave ${d}`);
  }
});

test('an unhealthy poller retries soon rather than waiting a full period', () => {
  // Waiting three hours to notice the collector came back would leave the wall
  // wrong for the whole period.
  const now = at('2026-08-09T01:10:00Z');
  assert.equal(nextPollDelay(now, PERIOD, OFFSET, false, 600_000), 600_000);
});

test('works across the epoch and for negative offsets', () => {
  assert.ok(nextPollDelay(0, PERIOD, OFFSET) > 0);
  assert.ok(nextPollDelay(at('2026-08-09T02:59:00Z'), PERIOD, -60_000) > 0);
});

test('auroraFromReading draws nothing without a reading', () => {
  // Kp 0 is a real, very quiet sky and still draws a thin oval; "we cannot
  // reach NOAA" must not be confused with it.
  assert.equal(auroraFromReading({ kp: null }).visible, false);
  assert.equal(auroraFromReading({ kp: undefined }).visible, false);
  assert.equal(auroraFromReading({ kp: 0 }).visible, true);
});

test('a disabled aurora layer stays off however good the reading is', () => {
  // THE REGRESSION THIS EXISTS FOR: visibility used to be decided from kp
  // alone, and apply() runs again on every poll -- so turning layers.aurora off
  // held for up to three hours and then the oval came back on its own, while
  // CONFIG.layers.aurora still said false. A control that silently reverts is
  // worse than one that never worked.
  for (const kp of [0, 3, 5, 9]) {
    assert.equal(auroraFromReading({ enabled: false, kp }).visible, false,
      `layers.aurora off was overridden by a Kp ${kp} reading`);
    assert.equal(auroraFromReading({ enabled: true, kp }).visible, true);
  }
});

test('the oval moves equatorward as Kp climbs, and clamps at the ends', () => {
  // ~66.5 degrees magnetic when quiet, ~1.7 degrees equatorward per Kp step --
  // the same rule as aurora.oval_boundary() on the collector.
  assert.equal(auroraFromReading({ kp: 0 }).edgeLat, 66.5);
  assert.equal(+auroraFromReading({ kp: 5 }).edgeLat.toFixed(1), 58.0);
  assert.equal(auroraFromReading({ kp: 9 }).edgeLat,
               auroraFromReading({ kp: 20 }).edgeLat, 'Kp is clamped at 9');
  assert.equal(auroraFromReading({ kp: -3 }).edgeLat, 66.5, 'and at 0');
});

test('a stale reading is drawn dimmer rather than confidently', () => {
  const fresh = auroraFromReading({ kp: 6, stale: false });
  const old = auroraFromReading({ kp: 6, stale: true });
  assert.equal(old.visible, true, 'a stale reading still draws');
  assert.ok(old.strength < fresh.strength, `${old.strength} !< ${fresh.strength}`);
});
