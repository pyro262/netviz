import test from 'node:test';
import assert from 'node:assert/strict';

import { cloudFade, nextPollDelay } from '../../netviz/static/js/schedule.js';

test('a current field draws at full strength', () => {
  const ttl = 3 * 3600;
  assert.equal(cloudFade(0, ttl), 1);
  assert.equal(cloudFade(ttl * 0.5, ttl), 1);
  assert.equal(cloudFade(ttl * 0.75, ttl), 1);
});

test('an aging field fades out instead of vanishing', () => {
  // A cloud field an hour stale is still broadly right about where the weather
  // is; one four hours stale is not. Fading across the last quarter of the ttl
  // means the wall never cuts from "weather" to "no weather" in one frame.
  const ttl = 3 * 3600;
  const mid = cloudFade(ttl * 0.875, ttl);
  assert.ok(mid > 0 && mid < 1, `expected a partial fade, got ${mid}`);
  assert.equal(cloudFade(ttl, ttl), 0);
  assert.equal(cloudFade(ttl * 2, ttl), 0);
});

test('never fetched is not the same as brand new', () => {
  // The one case that must not read as "clear skies everywhere": no field at
  // all. null age is what /clouds.json reports before the first success.
  assert.equal(cloudFade(null, 3600), 0);
  assert.equal(cloudFade(undefined, 3600), 0);
  assert.equal(cloudFade(-5, 3600), 0);
  assert.equal(cloudFade(10, 0), 0);
  assert.equal(cloudFade(10, NaN), 0);
});

test('the poll lands after the collector publishes, not on the hour', () => {
  // The collector fetches at 45 past; asking at the top of the hour asks for
  // the field it is about to replace.
  const hour = 3600_000;
  const offset = 48 * 60_000;
  const base = 1786737600_000;            // 2026-08-14T20:00:00Z
  assert.equal(nextPollDelay(base + offset - 60_000, hour, offset, true), 60_000);
  assert.equal(nextPollDelay(base + offset + 1000, hour, offset, true), hour - 1000);
});

test('a failed poll retries in minutes, not in an hour', () => {
  // Waiting a full period to notice the collector came back would leave the
  // globe bare for that period -- the same argument aurora.js makes.
  assert.equal(nextPollDelay(Date.now(), 3600_000, 48 * 60_000, false, 300_000), 300_000);
});

test('the poll delay is never zero', () => {
  // A zero delay spins setTimeout into a hot loop against the collector.
  const hour = 3600_000;
  const offset = 48 * 60_000;
  const base = 1786737600_000;
  for (const t of [base + offset, base + offset - 100, base + offset + 100]) {
    assert.ok(nextPollDelay(t, hour, offset, true) > 0);
  }
});
