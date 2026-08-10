import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay } from '../../netviz/static/js/schedule.js';

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
