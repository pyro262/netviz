import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay, auroraFromReading, nextLightningPoll, strokesDue, playbackStart } from '../../netviz/static/js/schedule.js';

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

test('strokesDue fires every stroke exactly once across a whole bucket', () => {
  const strokes = [];
  for (let s = 0; s < 600; s += 1) strokes.push([s, s / 10, -s / 10]);

  let cursor = 0;
  let fired = 0;
  for (let t = 0; t < 600; t += 1 / 6) {           // 6 frames per simulated second
    const out = strokesDue(strokes, t, t + 1 / 6, cursor);
    cursor = out.cursor;
    fired += out.items.length;
  }
  assert.equal(fired, strokes.length);
});

test('strokesDue does not fire a stroke sitting exactly on a window edge twice', () => {
  const strokes = [[10, 1, 2]];
  const a = strokesDue(strokes, 9, 10, 0);
  assert.equal(a.items.length, 0);                 // half-open: 10 is not in [9, 10)
  const b = strokesDue(strokes, 10, 11, a.cursor);
  assert.equal(b.items.length, 1);
  const c = strokesDue(strokes, 11, 12, b.cursor);
  assert.equal(c.items.length, 0);
});

test('strokesDue returns everything in a window that spans several seconds', () => {
  const strokes = [[0, 1, 1], [1, 2, 2], [2, 3, 3], [9, 4, 4]];
  const out = strokesDue(strokes, 0, 3, 0);
  assert.equal(out.items.length, 3);
  assert.equal(out.cursor, 3);
});

test('strokesDue on an empty bucket is empty, not a throw', () => {
  const out = strokesDue([], 0, 1, 0);
  assert.deepEqual(out.items, []);
  assert.equal(out.cursor, 0);
});

test('nextLightningPoll lands two and a half minutes past a ten-minute boundary', () => {
  // 32 minutes of publish lag is three whole buckets plus two minutes -- but
  // LIGHTNING_OFFSET_MS carries an extra +30_000 on top of that (see its
  // comment in schedule.js: polling at the SAME instant as the collector's
  // own poll deterministically reads the previous cycle's bucket), so the
  // useful phase within a 600s period is 150s, not 120s.
  const boundary = Date.UTC(2026, 7, 15, 7, 0, 0);
  for (const offset of [0, 61_000, 121_000, 500_000]) {
    const delay = nextLightningPoll(boundary + offset, true);
    const landed = (boundary + offset + delay) % 600_000;
    assert.ok(Math.abs(landed - 150_000) < 1000, `landed at ${landed}`);
    assert.ok(delay > 0 && delay <= 600_000);
  }
});

test('nextLightningPoll waits a whole period rather than firing a second early', () => {
  // The shared nextPollDelay guard returns the full period when the calculated
  // delay is ≤1000 ms, so a caller is never handed a sub-second delay that would
  // spin it into a hot loop. The aurora and cloud layers already depend on this.
  // With the 150s phase, a poll starting at 149_000 ms into a 600_000 ms period
  // has a raw delay of exactly 1000 ms, which triggers the guard: return the
  // full period instead. This is the intended behavior, documented here so it
  // is not mistaken for a bug.
  const boundary = Date.UTC(2026, 7, 15, 7, 0, 0);
  const delay = nextLightningPoll(boundary + 149_000, true);
  assert.equal(delay, 600_000);
});

test('playbackStart refuses a bucket that is already spent -- the boot-race guard', () => {
  // THE REGRESSION THIS EXISTS FOR: the renderer's LIGHTNING_OFFSET_MS used to
  // equal the collector's PUBLISH_LAG exactly, so both polled the same instant
  // and the renderer always read the PREVIOUS cycle's bucket. Verified: at
  // age=2520, lag=1920 (32 minutes), window=600, playAt clamped to exactly
  // 600 -- the end of the window -- and never fired another stroke.
  assert.equal(playbackStart(2520, 32 * 60, 600), null);
  // The fixed offset (150s phase) lands with room inside the window.
  const start = playbackStart(150 + 32 * 60, 32 * 60, 600);
  assert.equal(start, 150);
});

test('playbackStart clamps a bucket that arrived early to 0', () => {
  // age - lag can be negative if the poll lands before the nominal lag has
  // fully elapsed; playback cannot start before the bucket's own beginning.
  assert.equal(playbackStart(30, 32 * 60, 600), 0);
});

test('playbackStart treats a missing age as no bucket at all', () => {
  assert.equal(playbackStart(null, 32 * 60, 600), null);
  assert.equal(playbackStart(undefined, 32 * 60, 600), null);
});

test('playbackStart accepts a position exactly one second inside the window', () => {
  assert.equal(playbackStart(599, 0, 600), 599);
  assert.equal(playbackStart(600, 0, 600), null);   // exactly spent, refused
});

test('nextLightningPoll retries fast when unhealthy', () => {
  assert.equal(nextLightningPoll(Date.now(), false), 120_000);
});
