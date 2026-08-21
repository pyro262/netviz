import test from 'node:test';
import assert from 'node:assert/strict';
import { createShowcase, SAMPLE_ORIGINS, SAMPLE_STRIKES, TOUCHED_PATHS }
  from '../../netviz/static/js/showcase.js';

/** A display whose settings can be read and written, like the real pair. */
function stubs(over = {}) {
  const store = {
    'test.show.seconds': 30,
    'test.show.auroraKp': 7,
    'layers.aurora': true,
    'layers.lightning': false,
    'layers.clouds': false,
    'layers.countryFlash': true,
    'layers.ripples': true,
    'arcs.custom': [],
    ...(over.store || {}),
  };
  const applied = [];
  const spawned = [];
  const readings = [];
  const flashed = [];
  const struck = [];
  let clock = 1000;
  const s = {
    store, applied, spawned, readings, flashed, struck,
    advance: (ms) => { clock += ms; },
    arcs: { spawn: (ev, cls) => spawned.push({ ev, cls }) },
    aurora: {
      __setReading: (r) => readings.push(r),
      debug: () => ({ kp: 2, stale: false }),
    },
    lightning: { showSamples: (pts) => struck.push(pts.length) },
    globe: { flashCountry: (c) => flashed.push(c) },
    settings: {
      apply: (patch) => {
        applied.push(patch);
        Object.assign(store, patch);
        return { applied: Object.keys(patch), rejected: [] };
      },
    },
    read: (path, fallback) => (path in store ? store[path] : fallback),
    // Greenwich: a canonical reference point, and unmistakably not anybody's
    // home. The real one is site data and lives in .env, never in a test.
    home: () => ({ lat: 51.48, lon: 0.0 }),
    watched: () => ['DE', 'CN'],
    now: () => clock,
  };
  return { ...s, ...over, store, applied, spawned, readings, flashed, struck,
           advance: s.advance };
}

test('the sample places are real, far apart, and not the deployment', () => {
  assert.ok(SAMPLE_ORIGINS.length >= 4);
  for (const o of SAMPLE_ORIGINS) {
    assert.ok(Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180, o.name);
  }
  // Spread across both hemispheres, so an arc actually crosses the globe.
  assert.ok(SAMPLE_ORIGINS.some((o) => o.lat > 30));
  assert.ok(SAMPLE_ORIGINS.some((o) => o.lat < -20));
  assert.ok(SAMPLE_STRIKES.length >= 8);
});

test('nothing runs when nothing is ticked, and the wall is not touched', () => {
  const d = stubs();
  const sc = createShowcase(d);
  const out = sc.start();
  assert.equal(out.started, false);
  assert.deepEqual(d.applied, []);
  assert.deepEqual(d.spawned, []);
  assert.equal(sc.isRunning(), false);
});

test('a showing draws arcs with an EXPLICIT class, never through classify', () => {
  const d = stubs({ store: { 'test.show.blocked': true } });
  createShowcase(d).start();
  assert.ok(d.spawned.length >= 3);
  for (const s of d.spawned) {
    assert.equal(s.cls, 'block',
      'an arc spawned without a class would be classified, and counted');
  }
});

test('an aurora showing forces the chosen Kp and puts the real one back', () => {
  const d = stubs({ store: { 'test.show.aurora': true, 'test.show.auroraKp': 9 } });
  const sc = createShowcase(d);
  sc.start();
  assert.deepEqual(d.readings[0], { kp: 9, stale: false });
  sc.stop();
  // Back to what the display last heard from NOAA -- 2 in this stub -- rather
  // than to a default. A showing must not leave the wall claiming a storm.
  assert.deepEqual(d.readings[d.readings.length - 1], { kp: 2, stale: false });
});

test('a layer that was already ON is restored to ON, not to off', () => {
  // The restore records VALUES, not "did we turn it on". Restoring a layer
  // that was already on is as much a restore as restoring one that was off,
  // and only the recorded value knows which.
  const d = stubs({ store: { 'test.show.countryFlash': true, 'layers.countryFlash': true } });
  const sc = createShowcase(d);
  sc.start();
  sc.stop();
  assert.equal(d.store['layers.countryFlash'], true);
});

test('a layer that was OFF is turned on for the showing and off again after', () => {
  const d = stubs({ store: { 'test.show.lightning': true } });
  const sc = createShowcase(d);
  assert.equal(d.store['layers.lightning'], false);
  sc.start();
  assert.equal(d.store['layers.lightning'], true);
  assert.equal(d.struck[0], SAMPLE_STRIKES.length);
  sc.stop();
  assert.equal(d.store['layers.lightning'], false);
});

test('every path a showing can write is one it can put back', () => {
  // The one-way-door rule: a path a showing CHANGES but cannot RESTORE would be
  // left however the showing set it, for ever.
  const d = stubs({ store: {
    'test.show.aurora': true, 'test.show.lightning': true,
    'test.show.clouds': true, 'test.show.countryFlash': true,
    'test.show.ripples': true,
  } });
  const sc = createShowcase(d);
  sc.start();
  const written = new Set(d.applied.flatMap((p) => Object.keys(p)));
  for (const p of written) {
    assert.ok(TOUCHED_PATHS.includes(p), `${p} is written but never restored`);
  }
});

test('it ends on its own clock, so closing the panel can leave it running', () => {
  const d = stubs({ store: { 'test.show.lightning': true, 'test.show.seconds': 10 } });
  const sc = createShowcase(d);
  sc.start();
  assert.equal(sc.isRunning(), true);
  d.advance(9000);
  sc.tick();
  assert.equal(sc.isRunning(), true, 'ended early');
  d.advance(2000);
  sc.tick();
  assert.equal(sc.isRunning(), false, 'never ended');
  assert.equal(d.store['layers.lightning'], false, 'the timeout did not restore');
});

test('an item this display cannot do is REPORTED, not silently dropped', () => {
  // "no custom arcs are defined" and "this build has no lightning" are answers.
  // Quietly running four of five ticked items and saying nothing is not.
  const d = stubs({ store: { 'test.show.customArcs': true, 'test.show.lightning': true },
                    lightning: null });
  const out = createShowcase(d).start();
  const ids = out.skipped.map((s) => s.id).sort();
  assert.deepEqual(ids, ['customArcs', 'lightning']);
  for (const s of out.skipped) assert.ok(s.why && s.why.length > 10, s.id);
  assert.equal(out.started, false, 'nothing could run, so nothing started');
});

test('custom arcs draw one arc per rule, each in its own class', () => {
  const d = stubs({ store: {
    'test.show.customArcs': true,
    'arcs.custom': [{ match: 'DE' }, { match: '203.0.113.0/24' }],
  } });
  const out = createShowcase(d).start();
  assert.equal(out.started, true);
  assert.deepEqual(d.spawned.map((s) => s.cls), ['rule1', 'rule2']);
});

test('starting twice does not stack two showings', () => {
  const d = stubs({ store: { 'test.show.lightning': true } });
  const sc = createShowcase(d);
  sc.start();
  sc.start();
  sc.stop();
  assert.equal(d.store['layers.lightning'], false,
    'the second start recorded the SHOWING as the baseline');
});
