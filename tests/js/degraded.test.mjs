// The decision is pure so it can be tested without a browser: given what the
// last /health.json poll said, whether the socket is open, and the time, decide
// what the wall shows. Everything DOM-shaped lives in degraded.js's applyState.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, formatAge } from '../../netviz/static/js/degraded.js';

const ok = { feeds: { netflow: { ok: true, age: 3 } }, now: 1000 };

test('healthy feed and open socket is not degraded', () => {
  const s = decide({ health: ok, socketOpen: true, lastPollOk: true });
  assert.equal(s.degraded, false);
  assert.equal(s.text, '');
});

test('a stale feed names itself and its age', () => {
  const health = { feeds: { netflow: { ok: false, age: 252 } }, now: 1000 };
  const s = decide({ health, socketOpen: true, lastPollOk: true });
  assert.equal(s.degraded, true);
  assert.match(s.text, /NETFLOW STALE/);
  assert.match(s.text, /4m 12s/);
});

test('a failed poll outranks feed status -- the collector itself is gone', () => {
  const health = { feeds: { netflow: { ok: false, age: 900 } }, now: 1000 };
  const s = decide({ health, socketOpen: false, lastPollOk: false });
  assert.equal(s.degraded, true);
  assert.match(s.text, /COLLECTOR UNREACHABLE/);
});

test('a closed socket is degraded even while polls succeed', () => {
  const s = decide({ health: ok, socketOpen: false, lastPollOk: true });
  assert.equal(s.degraded, true);
  assert.match(s.text, /FEED DISCONNECTED/);
});

test('multiple stale feeds are all named', () => {
  const health = {
    feeds: { netflow: { ok: false, age: 90 }, blocks: { ok: false, age: 30000 } },
    now: 1000,
  };
  const s = decide({ health, socketOpen: true, lastPollOk: true });
  assert.match(s.text, /NETFLOW/);
  assert.match(s.text, /BLOCKS/);
});

test('a build with no /health.json is not reported as a dead feed', () => {
  // 404 leaves health null. The socket is the only signal left, and it is open.
  const s = decide({ health: null, socketOpen: true, lastPollOk: true });
  assert.equal(s.degraded, false);
});

test('a never-seen feed with a null age still reports', () => {
  const health = { feeds: { blocks: { ok: false, age: null } }, now: 1000 };
  const s = decide({ health, socketOpen: true, lastPollOk: true });
  assert.equal(s.degraded, true);
  assert.match(s.text, /BLOCKS STALE/);
  assert.match(s.text, /never/);
});

test('formatAge is compact enough for a wall banner', () => {
  assert.equal(formatAge(9), '9s');
  assert.equal(formatAge(75), '1m 15s');
  assert.equal(formatAge(3700), '1h 1m');
  assert.equal(formatAge(null), 'never');
});
