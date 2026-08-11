// Putting a changed setting on the wall.
//
// settings.js decides WHAT a patch is and which strategy each key needs; this
// file holds the live objects and does it. The split is deliberate: the
// decision half is pure and unit-tested, and this half is the only part that
// needs a GPU to verify.
//
// Order is uniform -> rebuild -> at most one relayout. A resize rebuilds the
// composer's render targets, so toggling three things that each want one must
// still cost one.
import { validate, planApply, paths } from './settings.js';
import { CONFIG } from './config.js';

/** Write a dotted path into CONFIG, so anything reading cfg() later agrees
 *  with what was just applied to the live objects. */
function writeConfig(path, value) {
  const keys = path.split('.');
  let node = CONFIG;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * One function per setting. Keyed by the exact dotted path, so a schema entry
 * and its handler cannot drift apart silently -- createApplier refuses to
 * build when they do, and a test asserts both directions.
 *
 * A handler receives (value, ctx) and mutates the live display. It does NOT
 * write CONFIG; the executor does that for every accepted key.
 */
export const HANDLERS = {
  'traffic.flowsPerSecond': (v, ctx) => ctx.arcs.setUniform('flowsPerSecond', v),
  'arcs.bodyOpacity': (v, ctx) => ctx.arcs.setUniform('bodyOpacity', v),
  'arcs.flow.tube': (v, ctx) => ctx.arcs.rebuild(),
  'appearance.background': (v, ctx) => ctx.globe.setUniform('background', v),
  'rail.enabled': (v, ctx) => {
    if (v && !ctx.rail.mounted()) ctx.rail.mount();
    if (!v && ctx.rail.mounted()) ctx.rail.unmount();
  },
};

/**
 * @param ctx  the live display: arcs, globe, stars, post, ripples, camera,
 *             rig, renderer, resize(), and rail {mount, unmount, mounted}
 * @param opts.extraPaths  test hook: pretend the schema also declares these,
 *             so the coverage assertion can be exercised without editing it
 */
export function createApplier(ctx, opts = {}) {
  const declared = paths().concat(opts.extraPaths || []);
  const orphans = declared.filter((p) => !HANDLERS[p]);
  if (orphans.length) {
    // At construction, on the wall, at boot -- not at the moment somebody
    // moves the one slider nobody wired up.
    throw new Error(`settings with no handler: ${orphans.join(', ')}`);
  }

  return {
    apply(patch) {
      const { accepted, rejected } = validate(patch);
      const plan = planApply(accepted);
      const applied = [];
      // ctx.setConfig exists so a test can observe the write without mutating
      // the real CONFIG; the page passes nothing and gets writeConfig.
      const setConfig = ctx.setConfig || writeConfig;
      const run = (path) => {
        try {
          HANDLERS[path](accepted[path], ctx);
          setConfig(path, accepted[path]);
          applied.push(path);
        } catch (err) {
          // One bad setting must not leave the wall half-applied and the rest
          // dropped; the display is more useful than the guarantee.
          rejected.push({ path, value: accepted[path], why: String(err) });
        }
      };
      for (const p of plan.uniform) run(p);
      for (const p of plan.rebuild) run(p);
      if (plan.relayout) {
        for (const p of Object.keys(accepted)) {
          if (!plan.uniform.includes(p) && !plan.rebuild.includes(p)) run(p);
        }
        ctx.resize();
      }
      return { applied, rejected };
    },
    unhandled() { return paths().filter((p) => !HANDLERS[p]); },
  };
}
