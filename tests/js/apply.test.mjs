import test from 'node:test';
import assert from 'node:assert/strict';

import { createApplier, HANDLERS, ARC_REBUILD_KEYS } from '../../netviz/static/js/apply.js';
import { paths, entry } from '../../netviz/static/js/settings.js';
import { validateZoomRange } from '../../netviz/static/js/orbit.js';
import { CONFIG } from '../../netviz/static/js/config.js';

/** Records what the executor did, in order.
 *
 *  Every method a handler calls has to be here, or the coverage the schema
 *  tests give would stop at "a handler exists" and say nothing about whether it
 *  can run. */
function fakeCtx(log) {
  return {
    setConfig: (p, v) => log.push(`config ${p}=${v}`),
    arcs: {
      rebuild: () => log.push('arcs.rebuild'),
      setUniform: (p, v) => log.push(`arcs ${p}=${v}`),
      setSpec: (c, k, v) => log.push(`arcs ${c}.${k}=${v}`),
    },
    globe: { setLayer: (n, v) => log.push(`layer ${n}=${v}`) },
    stars: {
      setVisible: (v) => log.push(`stars visible=${v}`),
      setBrightness: (v) => log.push(`stars brightness=${v}`),
      setDayGain: (v) => log.push(`stars dayGain=${v}`),
      setRampMinutes: (v) => log.push(`stars rampMinutes=${v}`),
    },
    post: { setBloom: (p, v) => log.push(`bloom ${p}=${v}`) },
    scene: { background: { set: (v) => log.push(`background=${v}`) } },
    ripples: { setCooldown: (v) => log.push(`ripples cooldown=${v}`) },
    camera: {},
    rig: { setParam: (p, v) => log.push(`rig ${p}=${v}`) },
    input: { setParam: (p, v) => log.push(`input ${p}=${v}`) },
    polling: (k, v) => log.push(`polling ${k}=${v}`),
    renderer: {},
    resize: () => log.push('resize'),
    rail: {
      _on: false,
      mount() { this._on = true; log.push('rail.mount'); },
      unmount() { this._on = false; log.push('rail.unmount'); },
      mounted() { return this._on; },
    },
  };
}

test('every schema path has a handler', () => {
  // The schema and the executor are two lists that must not drift. A path with
  // no handler is a control in the panel that silently does nothing, which is
  // worse than a missing control: it reads as a display that ignores you.
  const orphans = paths().filter((p) => !HANDLERS[p]);
  assert.deepEqual(orphans, [], `paths with no handler: ${orphans.join(', ')}`);
});

test('every handler has a schema path', () => {
  const strays = Object.keys(HANDLERS).filter((p) => !paths().includes(p));
  assert.deepEqual(strays, [], `handlers with no schema entry: ${strays.join(', ')}`);
});

test('the arc keys that clear the pool are exactly the ones declared rebuild', () => {
  // The strategy has to describe what a viewer will SEE. lift, maxRise and tube
  // are baked into a slot's TubeGeometry at spawn, so they cannot be pushed
  // into the arcs already in the air; everything else about an arc can be, and
  // is. If the two lists ever disagree, one of them is lying about the display.
  const declaredRebuild = paths()
    .filter((p) => p.startsWith('arcs.') && entry(p).strategy === 'rebuild')
    .map((p) => p.split('.')[2]);
  assert.deepEqual([...new Set(declaredRebuild)].sort(), [...ARC_REBUILD_KEYS].sort());
});

test('a rebuild arc key pushes the value AND clears the pool', () => {
  // setSpec alone would show a new tube radius only on arcs not yet drawn, and
  // the executor writes CONFIG after the handler runs -- so re-reading cfg()
  // inside rebuild() would read the old value. The value has to be passed.
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({ 'arcs.block.maxRise': 0.3 });
  assert.ok(log.includes('arcs block.maxRise=0.3'), `no setSpec: ${log}`);
  assert.ok(log.includes('arcs.rebuild'), `no rebuild: ${log}`);
});

test('a uniform arc key does not clear the pool', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({ 'arcs.block.colorAt': 0.9 });
  assert.ok(log.includes('arcs block.colorAt=0.9'), `no setSpec: ${log}`);
  assert.equal(log.filter((l) => l === 'arcs.rebuild').length, 0);
});

/**
 * A ctx whose rig holds a REAL zoom range and validates exactly as camera.js
 * does: whole pair, checked before either end is assigned.
 *
 * The stateless fake cannot express these cases at all -- the whole question is
 * what the range is part-way through a patch -- and `bounds` is seeded into
 * CONFIG as well, because the handlers read the end this patch does not carry
 * back out of config.js.
 */
function fakeRangeCtx(log, bounds) {
  const ctx = fakeCtx(log);
  ctx.range = [...bounds];
  ctx.rig.setParam = (p, v) => {
    if (p === 'input.zoomRange') {
      const [lo, hi] = validateZoomRange(v[0], v[1]);   // throws before assigning
      ctx.range = [lo, hi];
      return;
    }
    log.push(`rig ${p}=${v}`);
  };
  CONFIG.input.zoomRange = [...bounds];
  // Not the recording stub: these tests need cfg() to see the writes, since
  // that is where a handler reads the end its own key does not carry.
  ctx.setConfig = null;
  return ctx;
}

test('a two-sided zoom range shift is accepted on its FINAL pair', () => {
  // [3.3, 5.0] -> [8.0, 12.0]. Validating one end at a time checks 8.0 against
  // a stale 5.0 and refuses a perfectly good range. The panel emits exactly
  // this patch when somebody drags both ends of a range control.
  const ctx = fakeRangeCtx([], [3.3, 5.0]);
  const out = createApplier(ctx).apply({
    'input.zoomRange.0': 8.0, 'input.zoomRange.1': 12.0,
  });
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.applied.sort(), ['input.zoomRange.0', 'input.zoomRange.1']);
  assert.deepEqual(ctx.range, [8.0, 12.0]);
  assert.deepEqual(CONFIG.input.zoomRange, [8.0, 12.0]);
});

test('the same two-sided shift in the opposite key order is identical', () => {
  // planApply walks Object.entries order, so the caller's insertion order is
  // the executor's order. The decision must not be able to see it.
  const a = fakeRangeCtx([], [3.3, 5.0]);
  const outA = createApplier(a).apply({
    'input.zoomRange.0': 8.0, 'input.zoomRange.1': 12.0,
  });
  const b = fakeRangeCtx([], [3.3, 5.0]);
  const outB = createApplier(b).apply({
    'input.zoomRange.1': 12.0, 'input.zoomRange.0': 8.0,
  });
  assert.deepEqual(a.range, b.range);
  assert.deepEqual(outA.applied.sort(), outB.applied.sort());
  assert.deepEqual(outA.rejected, outB.rejected);
  assert.deepEqual(b.range, [8.0, 12.0]);
});

test('a two-key patch whose FINAL pair is invalid is rejected, both ends untouched', () => {
  for (const patch of [{ 'input.zoomRange.0': 9.0, 'input.zoomRange.1': 4.0 },
                       { 'input.zoomRange.1': 4.0, 'input.zoomRange.0': 9.0 },
                       { 'input.zoomRange.0': 6.0, 'input.zoomRange.1': 6.0 }]) {
    const ctx = fakeRangeCtx([], [3.3, 9.0]);
    const out = createApplier(ctx).apply(patch);
    assert.deepEqual(out.applied, [], `applied something: ${JSON.stringify(patch)}`);
    assert.deepEqual(out.rejected.map((r) => r.path).sort(),
                     ['input.zoomRange.0', 'input.zoomRange.1']);
    for (const r of out.rejected) assert.match(r.why, /not below/);
    // A refusal must not leave the range half-moved.
    assert.deepEqual(ctx.range, [3.3, 9.0]);
    assert.deepEqual(CONFIG.input.zoomRange, [3.3, 9.0]);
  }
});

test('a zoom range that would NaN the camera is rejected, not applied', () => {
  // clampDistance propagates a bad bound rather than refusing it: the camera
  // position goes NaN and the display goes black with nothing in the console.
  // The rig's guard throws, and the executor turns that into a rejection.
  const ctx = fakeRangeCtx([], [3.3, 9.0]);
  const applier = createApplier(ctx);

  // Below the limb-clip floor: coerce clamps it back up before the rig ever
  // sees it, so this one is APPLIED at the floor rather than rejected.
  const low = applier.apply({ 'input.zoomRange.0': 1.0 });
  assert.deepEqual(low.applied, ['input.zoomRange.0']);
  assert.deepEqual(ctx.range, [3.3, 9.0]);

  // One end alone, in bounds, invalid against the end that is NOT moving. Still
  // refused -- this pair really is invalid, unlike the two-key case above.
  const bad = applier.apply({ 'input.zoomRange.0': 9.0 });
  assert.deepEqual(bad.applied, []);
  assert.equal(bad.rejected.length, 1);
  assert.equal(bad.rejected[0].path, 'input.zoomRange.0');
  assert.match(bad.rejected[0].why, /not below/);
  assert.deepEqual(ctx.range, [3.3, 9.0]);
});

test('creating an applier with an orphaned path throws, loudly', () => {
  // Fail at construction, on the wall, at boot -- not at the moment somebody
  // moves the one slider nobody wired up.
  assert.throws(() => createApplier(fakeCtx([]), { extraPaths: ['made.up.path'] }),
    /made\.up\.path/);
});

test('a patch runs uniform, then rebuild, then one relayout', () => {
  const log = [];
  const ctx = fakeCtx(log);
  const applier = createApplier(ctx);
  applier.apply({
    'arcs.flow.tube': 0.004,        // rebuild
    'rail.enabled': true,           // relayout
    'arcs.bodyOpacity': 0.2,        // uniform
  });
  const iUniform = log.indexOf('config arcs.bodyOpacity=0.2');
  const iRebuild = log.indexOf('arcs.rebuild');
  const iResize = log.indexOf('resize');
  assert.ok(iUniform > -1 && iRebuild > -1 && iResize > -1, `missing steps: ${log}`);
  assert.ok(iUniform < iRebuild, 'uniform must run before rebuild');
  assert.ok(iRebuild < iResize, 'the resize must come last');
});

test('one resize however many relayout keys are in the patch', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({ 'rail.enabled': true, 'arcs.bodyOpacity': 0.2 });
  assert.equal(log.filter((l) => l === 'resize').length, 1);
});

test('the rail toggles both ways and is idempotent', () => {
  const log = [];
  const ctx = fakeCtx(log);
  const applier = createApplier(ctx);
  applier.apply({ 'rail.enabled': true });
  assert.equal(ctx.rail.mounted(), true);
  applier.apply({ 'rail.enabled': true });     // already on
  assert.equal(log.filter((l) => l === 'rail.mount').length, 1,
    'mounting an already-mounted rail');
  applier.apply({ 'rail.enabled': false });
  assert.equal(ctx.rail.mounted(), false);
});

test('a rejected value changes nothing and is reported', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  const out = applier.apply({ 'arcs.bodyOpacity': 'thick' });
  assert.deepEqual(out.applied, []);
  assert.equal(out.rejected[0].path, 'arcs.bodyOpacity');
  assert.deepEqual(log, [], 'a rejected value touched the display');
});

test('a handler that throws does not cost the rest of the patch', () => {
  // One bad setting must not leave the wall half-applied and the rest dropped.
  const log = [];
  const ctx = fakeCtx(log);
  ctx.arcs.setUniform = () => { throw new Error('boom'); };
  const applier = createApplier(ctx);
  const out = applier.apply({ 'arcs.bodyOpacity': 0.2, 'appearance.background': '#000' });
  assert.ok(out.applied.includes('appearance.background'),
    'a later key was dropped because an earlier one threw');
});
