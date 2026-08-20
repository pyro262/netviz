import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfTest, LANDMARKS } from '../../netviz/static/js/selftest.js';

function stubs(over = {}) {
  return {
    arcs: { drawSample: () => {}, count: () => 0 },
    project: (lat, lon) => ({ x: 1000 - lon * 2, y: 500 - lat * 2 }),
    // The renderer's own convention, `theta = -lon`, which puts
    // z = -r * sin(phi) * sin(lon).
    vec3: (lat, lon) => {
      const phi = ((90 - lat) * Math.PI) / 180;
      const theta = (-lon * Math.PI) / 180;
      return { x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi),
               z: Math.sin(phi) * Math.sin(theta) };
    },
    stats: async () => ({ ipfix: { records: 10 }, syslog: { datagrams: 5, events: 2 } }),
    socket: () => ({ readyState: 1 }),
    pause: () => {}, resume: () => {},
    ...over,
  };
}

test('the feed is paused for the run and resumed after it', async () => {
  const order = [];
  const st = createSelfTest(stubs({
    pause: () => order.push('pause'), resume: () => order.push('resume'),
  }));
  await st.run(['test.arcs.flow']);
  assert.deepEqual(order, ['pause', 'resume']);
});

test('the feed is resumed even when a check throws', async () => {
  const order = [];
  const st = createSelfTest(stubs({
    pause: () => order.push('pause'), resume: () => order.push('resume'),
    arcs: { drawSample: () => { throw new Error('boom'); }, count: () => 0 },
  }));
  const out = await st.run(['test.arcs.flow']);
  assert.deepEqual(order, ['pause', 'resume']);
  assert.equal(out[0].status, 'fail');
  assert.match(out[0].reason, /boom/);
});

test('a geo check asserts numerically and fails on a mirrored projection', async () => {
  const good = createSelfTest(stubs());
  assert.equal((await good.run(['test.geo.landmarks']))[0].status, 'pass');
  // `+lon` instead of `-lon`: the one-character mistake this check exists for.
  const mirrored = createSelfTest(stubs({
    vec3: (lat, lon) => {
      const phi = ((90 - lat) * Math.PI) / 180;
      const theta = (lon * Math.PI) / 180;
      return { x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi),
               z: Math.sin(phi) * Math.sin(theta) };
    },
  }));
  const out = (await mirrored.run(['test.geo.landmarks']))[0];
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /Sydney|Reykjavik|Cape Town/);
});

test('a point behind the limb is SKIPPED, never passed', async () => {
  const st = createSelfTest(stubs({ project: () => null }));
  const out = (await st.run(['test.geo.landmarks']))[0];
  assert.equal(out.status, 'skipped');
  assert.match(out.reason, /behind/i);
});

test('every landmark is far from both 0 and 180 degrees of longitude', () => {
  // The property that makes the check able to catch a mirror at all: a landmark
  // near the prime meridian projects to almost the same place either way.
  for (const l of LANDMARKS) {
    const from0 = Math.abs(l.lon);
    const from180 = Math.abs(180 - Math.abs(l.lon));
    assert.ok(from0 > 15, `${l.name} is only ${from0.toFixed(0)} deg from the meridian`);
    assert.ok(from180 > 15, `${l.name} is only ${from180.toFixed(0)} deg from 180`);
  }
});

test('a live feed carrying no policy logs is not reported as a dead one', async () => {
  const st = createSelfTest(stubs({
    stats: async () => ({ ipfix: { records: 10 }, syslog: { datagrams: 40, events: 0 } }),
  }));
  const out = (await st.run(['test.feeds.blocks']))[0];
  assert.equal(out.status, 'pass');
  assert.match(out.reason, /no policy logs|carrying none/i);
});

test('a dead syslog feed fails and says so', async () => {
  const st = createSelfTest(stubs({
    stats: async () => ({ ipfix: { records: 10 }, syslog: { datagrams: 0, events: 0 } }),
  }));
  const out = (await st.run(['test.feeds.blocks']))[0];
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /no datagrams|nothing/i);
});

test('an unreachable collector skips the feed checks rather than failing them', async () => {
  const st = createSelfTest(stubs({ stats: async () => { throw new Error('offline'); } }));
  const out = await st.run(['test.feeds.netflow', 'test.feeds.blocks']);
  assert.ok(out.every((r) => r.status === 'skipped'),
    'a check that could not run has not passed and has not failed');
});

test('a closed socket fails, and an absent one is skipped', async () => {
  const closed = createSelfTest(stubs({ socket: () => ({ readyState: 3 }) }));
  assert.equal((await closed.run(['test.feeds.socket']))[0].status, 'fail');
  const absent = createSelfTest(stubs({ socket: () => null }));
  assert.equal((await absent.run(['test.feeds.socket']))[0].status, 'skipped');
});

test('a path with no check is skipped by name, never silently dropped', async () => {
  const st = createSelfTest(stubs());
  const out = await st.run(['test.nonsense']);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'skipped');
  assert.equal(out[0].id, 'test.nonsense');
});

test('running nothing returns nothing and never pauses the wall', async () => {
  const order = [];
  const st = createSelfTest(stubs({
    pause: () => order.push('pause'), resume: () => order.push('resume'),
  }));
  assert.deepEqual(await st.run([]), []);
  assert.deepEqual(order, [], 'pausing to run no checks freezes the wall for nothing');
});
