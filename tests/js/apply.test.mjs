import test from 'node:test';
import assert from 'node:assert/strict';

import { createApplier, HANDLERS } from '../../netviz/static/js/apply.js';
import { paths } from '../../netviz/static/js/settings.js';

/** Records what the executor did, in order. */
function fakeCtx(log) {
  return {
    setConfig: (p, v) => log.push(`config ${p}=${v}`),
    arcs: { rebuild: () => log.push('arcs.rebuild'), setUniform: (p, v) => log.push(`arcs ${p}=${v}`) },
    globe: { setUniform: (p, v) => log.push(`globe ${p}=${v}`) },
    stars: { rebuild: () => log.push('stars.rebuild') },
    post: { setUniform: (p, v) => log.push(`post ${p}=${v}`) },
    ripples: {},
    camera: {},
    rig: {},
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
