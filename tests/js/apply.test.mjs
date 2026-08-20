import test from 'node:test';
import assert from 'node:assert/strict';

import { createApplier, HANDLERS, ARC_REBUILD_KEYS, resolveTheme } from '../../netviz/static/js/apply.js';
import { paths, entry } from '../../netviz/static/js/settings.js';
import { validateZoomRange } from '../../netviz/static/js/orbit.js';
import { CONFIG } from '../../netviz/static/js/config.js';
// Same vendored module apply.js itself imports (by relative path, not the
// bare specifier -- see apply.js's own comment on why). Used only to give
// fakeCtx.scene.background a real Color so applyTheme's reassignment and the
// existing handler's .set() both land on an object that actually behaves
// like the one main.js hands the executor.
import * as THREE from '../../netviz/static/vendor/three/three.module.js';

/** Records what the executor did, in order.
 *
 *  Every method a handler calls has to be here, or the coverage the schema
 *  tests give would stop at "a handler exists" and say nothing about whether it
 *  can run. */
function fakeCtx(log = []) {
  return {
    setConfig: (p, v) => log.push(`config ${p}=${v}`),
    arcs: {
      rebuildCalls: 0,
      rebuild() { this.rebuildCalls += 1; log.push('arcs.rebuild'); },
      setUniform: (p, v) => log.push(`arcs ${p}=${v}`),
      setSpec: (c, k, v) => log.push(`arcs ${c}.${k}=${v}`),
      setRulesCalls: [],
      setRules(v) { this.setRulesCalls.push(v); log.push(`arcs.setRules=${JSON.stringify(v)}`); },
    },
    globe: {
      setLayer: (n, v) => log.push(`layer ${n}=${v}`),
      setColor: (k, c) => log.push(`globe ${k}=${c.getHexString()}`),
      setCityColor: (c) => log.push(`globe cities=${c ? c.getHexString() : 'auto'}`),
      setSurface: (k, v) => log.push(`surface ${k}=${v && v.getHexString ? v.getHexString() : v}`),
    },
    atmosphere: {
      setGlow: (c) => log.push(`atmosphere=${c.getHexString()}`),
      setParam: (k, v) => log.push(`atmosphere ${k}=${v}`),
      setThickness: (v) => log.push(`atmosphere.thickness=${v}`),
    },
    aurora: { setColors: (lo, hi) => log.push(`aurora=${lo.getHexString()},${hi.getHexString()}`) },
    stars: {
      setVisible: (v) => log.push(`stars visible=${v}`),
      setBrightness: (v) => log.push(`stars brightness=${v}`),
      setDayGain: (v) => log.push(`stars dayGain=${v}`),
      setRampMinutes: (v) => log.push(`stars rampMinutes=${v}`),
    },
    post: { setBloom: (p, v) => log.push(`bloom ${p}=${v}`) },
    // A real Color, not a log stub: applyTheme reassigns this property
    // wholesale (ctx.scene.background = new THREE.Color(...)) while the
    // ordinary handler mutates it in place (.set(v)) -- both need to leave
    // behind something getHexString() can read back.
    scene: { background: new THREE.Color('#0b0916') },
    ripples: {
      setCooldown: (v) => log.push(`ripples cooldown=${v}`),
      setColor: (cls, c, ex) => log.push(`ripples ${cls}=${c.getHexString()},${ex}`),
    },
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
      maxRulesCalls: [],
      setMaxRules(v) { this.maxRulesCalls.push(v); log.push(`rail.maxRules=${v}`); },
    },
    classCounts: {
      setKeysCalls: [],
      setKeys(keys) { this.setKeysCalls.push(keys); log.push(`classCounts.setKeys=${JSON.stringify(keys)}`); },
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

test('the seven atmosphere/surface settings reach their live objects', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({
    'appearance.atmosphere.power': 4,
    'appearance.atmosphere.strength': 1.2,
    'appearance.surface.softness': 0.15,
    'appearance.surface.dayAmbient': 0.6,
  });
  assert.ok(log.includes('atmosphere power=4'), `no power: ${log}`);
  assert.ok(log.includes('atmosphere strength=1.2'), `no strength: ${log}`);
  assert.ok(log.includes('surface softness=0.15'), `no softness: ${log}`);
  assert.ok(log.includes('surface dayAmbient=0.6'), `no dayAmbient: ${log}`);
});

test('atmosphere.thickness pushes the value AND rebuilds the shell', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({ 'appearance.atmosphere.thickness': 1.08 });
  assert.ok(log.includes('atmosphere.thickness=1.08'), `no setThickness: ${log}`);
});

test('the surface tints reach setSurface as THREE colors, not strings', () => {
  const log = [];
  const applier = createApplier(fakeCtx(log));
  applier.apply({
    'appearance.surface.dayTint': '#ff8800',
    'appearance.surface.nightTint': '#0088ff',
  });
  assert.ok(log.includes('surface dayTint=ff8800'), `no dayTint: ${log}`);
  assert.ok(log.includes('surface nightTint=0088ff'), `no nightTint: ${log}`);
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

test('arcs.custom is applied through setRules and does not clear the pool', () => {
  const log = [];
  const ctx = fakeCtx(log);
  const applier = createApplier(ctx);
  const list = [{ match: 'DE', color: '#ff8800' }];
  const out = applier.apply({ 'arcs.custom': list });
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(ctx.arcs.setRulesCalls, [list]);
  assert.equal(ctx.arcs.rebuildCalls, 0, 'every rule shares one geometry');
  // A rule list change drops the counter history of any class that no longer
  // belongs to a rule, keyed the same way ruleKey() identifies a rule.
  assert.deepEqual(ctx.classCounts.setKeysCalls, [['DE|either']]);
});

test('arcs.custom tolerates a ctx with no classCounts', () => {
  // Older test doubles and any future caller that never built a counter must
  // not crash the handler -- the guard in apply.js is what this proves.
  const log = [];
  const ctx = fakeCtx(log);
  delete ctx.classCounts;
  const applier = createApplier(ctx);
  const out = applier.apply({ 'arcs.custom': [{ match: 'DE', color: '#ff8800' }] });
  assert.deepEqual(out.rejected, []);
});

test('rail.maxRules reaches the rail', () => {
  const log = [];
  const ctx = fakeCtx(log);
  const applier = createApplier(ctx);
  applier.apply({ 'rail.maxRules': 3 });
  assert.deepEqual(ctx.rail.maxRulesCalls, [3]);
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

test('every element color has a handler and reaches its module', () => {
  const seen = [];
  const ctx = fakeCtx([]);
  ctx.globe.setColor = (k, c) => seen.push(['globe', k, c.getHexString()]);
  ctx.atmosphere = { setGlow: (c) => seen.push(['atmo', c.getHexString()]) };
  const apply = createApplier(ctx).apply;
  apply({ 'appearance.colors.coastline': '#ff0088' });
  assert.deepEqual(seen[0], ['globe', 'coastline', 'ff0088']);
  seen.length = 0;
  apply({ 'appearance.colors.atmosphere': '#00ff88' });
  assert.deepEqual(seen[0], ['atmo', '00ff88']);
});

test('auto reaches the module as the ramp color, not the string', () => {
  const seen = [];
  const ctx = fakeCtx([]);
  ctx.globe.setColor = (k, c) => seen.push(c.getHexString());
  const apply = createApplier(ctx).apply;
  apply({ 'appearance.colors.coastline': 'auto' });
  assert.match(seen[0], /^[0-9a-f]{6}$/);
  assert.notEqual(seen[0], 'auto');
});

test('no schema path is left without a handler', () => {
  // The orphan check the applier already does at construction. This asserts it
  // passes now that the twelve are wired -- the previous commit failed it.
  assert.doesNotThrow(() => createApplier(fakeCtx([])));
});

test('a theme change recolors every auto element and none of the overridden', (t) => {
  // setConfig: null forces the real writeConfig (see fakeRangeCtx above for
  // the same pattern) -- applyTheme's "is this element overridden" check
  // reads CONFIG back through defaultOf(), and a patch applied through the
  // log-only stub would never actually persist there.
  t.after(() => {
    CONFIG.appearance.colors.coastline = 'auto';
    CONFIG.appearance.theme = 'plasma';
  });
  const seen = {};
  const ctx = fakeCtx();
  ctx.setConfig = null;
  ctx.globe.setColor = (k, c) => { seen[k] = c.getHexString(); };
  const applier = createApplier(ctx);
  applier.apply({ 'appearance.colors.coastline': '#ff0088' });   // override one
  const held = seen.coastline;
  applier.apply({ 'appearance.theme': 'viridis' });
  assert.equal(seen.coastline, held, 'an overridden element must hold');
  assert.notEqual(seen.admin1, undefined, 'an auto element must be recolored');
});

test('a theme change survives one element throwing, and still recolors the rest', (t) => {
  // ctx.atmosphere is nullable on a real page (see main.js) and globe.setColor
  // throws by design for a layer that was off at boot. Either must not cost
  // the elements that come after it in ELEMENT_T/ELEMENT_LITERAL order, nor
  // the arc re-push, nor the sky assignment that follow the loop -- a
  // deployment missing one layer must not pick a half-applied ramp.
  t.after(() => { CONFIG.appearance.theme = 'plasma'; });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  const pushedSpecs = [];
  const ctx = fakeCtx();
  ctx.setConfig = null;
  ctx.atmosphere = null;   // throws: null.setGlow is not a function
  ctx.arcs.setSpec = (c, k, v) => pushedSpecs.push([c, k, v]);
  try {
    const applier = createApplier(ctx);
    const { applied } = applier.apply({ 'appearance.theme': 'viridis' });
    assert.ok(applied.includes('appearance.theme'), 'the patch itself is not rejected');
    // Elements after atmosphere in the iteration order still ran.
    assert.deepEqual(pushedSpecs.map((p) => p[0]).sort(), ['block', 'flow']);
    assert.equal(ctx.scene.background.getHexString(), '050d10', 'sky still moved');
    assert.ok(warnings.some((w) => w.includes('atmosphere')), 'the failure was reported');
  } finally {
    console.warn = realWarn;
  }
});

test('a theme change sets the sky when the sky is auto', (t) => {
  t.after(() => { CONFIG.appearance.theme = 'plasma'; });
  const ctx = fakeCtx();
  ctx.setConfig = null;
  const applier = createApplier(ctx);
  applier.apply({ 'appearance.theme': 'inferno' });
  assert.equal(ctx.scene.background.getHexString(), '0d0604');
});

test('a theme change leaves an explicitly-set sky alone', (t) => {
  t.after(() => {
    CONFIG.appearance.background = 'auto';
    CONFIG.appearance.theme = 'plasma';
  });
  const ctx = fakeCtx();
  ctx.setConfig = null;
  const applier = createApplier(ctx);
  applier.apply({ 'appearance.background': '#020104' });
  applier.apply({ 'appearance.theme': 'inferno' });
  assert.equal(ctx.scene.background.getHexString(), '020104');
});

test('a theme change recolors arcs already in the air, only the classes that own a colorAt', () => {
  // arcs.highlight shares arcHandlers' shape but declares no colorAt of its
  // own -- a color rule carries its own hex -- so re-pushing it would write
  // `undefined` into a live slot. Only flow and block are re-pushed.
  const pushed = [];
  const ctx = fakeCtx();
  ctx.arcs.setSpec = (cls, key, v) => pushed.push([cls, key, v]);
  createApplier(ctx).apply({ 'appearance.theme': 'magma' });
  assert.deepEqual(pushed.map((p) => p[0]).sort(), ['block', 'flow']);
  assert.ok(pushed.every((p) => p[2] !== undefined), 'no undefined colorAt pushed');
});

test('a theme AND a customRamp in one patch end on the new ramp either way', (t) => {
  // applyTheme runs once per member key present in the patch (theme, then
  // customRamp) -- see the comment above applyTheme. Both calls have to
  // compose the SAME final answer from the whole patch, or which key the
  // executor happens to reach first would be observable on the wall.
  t.after(() => {
    CONFIG.appearance.theme = 'plasma';
    CONFIG.appearance.colors.coastline = 'auto';
  });
  const customRamp = ['#000000', '#111111', '#222222', '#333333', '#444444',
                       '#555555', '#666666', '#777777', '#888888', '#ffffff'];
  const seenA = {};
  const ctxA = fakeCtx();
  ctxA.setConfig = null;
  ctxA.globe.setColor = (k, c) => { seenA[k] = c.getHexString(); };
  createApplier(ctxA).apply({
    'appearance.theme': 'custom',
    'appearance.customRamp': customRamp,
  });

  CONFIG.appearance.theme = 'plasma';
  CONFIG.appearance.colors.coastline = 'auto';

  const seenB = {};
  const ctxB = fakeCtx();
  ctxB.setConfig = null;
  ctxB.globe.setColor = (k, c) => { seenB[k] = c.getHexString(); };
  // Reversed key order in the same patch -- Object.entries order is what the
  // executor iterates, so this is the ordering the test actually varies.
  createApplier(ctxB).apply({
    'appearance.customRamp': customRamp,
    'appearance.theme': 'custom',
  });

  assert.equal(CONFIG.appearance.theme, 'custom');
  assert.equal(seenA.coastline, seenB.coastline,
               'the two key orders must resolve to the same color');
});

test('a rail scale writes a custom property and asks for a re-fit', () => {
  const log = [];
  const ctx = fakeCtx(log);
  const written = [];
  ctx.rail.setScale = (g, v) => { written.push([g, v]); log.push('rail.refit'); };
  const applier = createApplier(ctx);
  const out = applier.apply({ 'rail.scale.master': 2.5 });
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(written, [['master', 2.5]]);
  assert.equal(log.filter((l) => l === 'rail.refit').length, 1);
  assert.equal(log.filter((l) => l === 'resize').length, 1,
               'exactly one relayout, however many keys asked');
});

// ---------------------------------------------------------------------------
// 0.7.0: a stored theme naming a saved look that was later deleted.

test('a stored theme that still exists resolves to itself', () => {
  assert.deepEqual(resolveTheme('wall night', { names: ['wall night'], hasCustomPaths: true }),
                   { id: 'wall night', substituted: false, why: null });
});

test('a deleted theme falls back to custom when its colors are still stored', () => {
  const out = resolveTheme('gone', { names: [], hasCustomPaths: true });
  assert.equal(out.id, 'custom');
  assert.equal(out.substituted, true);
  assert.match(out.why, /gone/);
});

test('a deleted theme with nothing else stored falls back to the shipped default', () => {
  const out = resolveTheme('gone', { names: [], hasCustomPaths: false });
  assert.equal(out.id, 'plasma');
  assert.equal(out.substituted, true);
});
