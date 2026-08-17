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
// A relative import, not the bare 'three' every other three-facing module
// uses -- those resolve only through the browser import map (index.html) and
// are never node-tested. apply.js is unlike them: settings.test.mjs and
// tuner.test.mjs already import it under `node --test`, which has no import
// map and cannot see a bare 'three' at all. The vendored module resolves
// cleanly by relative path with no shim and no node_modules -- verified: a
// plain `node --eval` import of it constructs a real THREE.Color correctly.
import * as THREE from '../vendor/three/three.module.js';
import { validate, planApply, paths, defaultOf } from './settings.js';
import { CONFIG } from './config.js';
import { resolveColor, isAuto } from './elements.js';
// burst.js is three-free and its thresholds live in one exported object that
// createBurstDetector() closes over by default, so the detour thresholds are
// reached by mutating that object rather than through ctx. Importing it keeps
// main.js from having to hand a fourth pure module into the context.
import { BURST } from './burst.js';
import { ruleKey } from './classcount.js';

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
 * A handler receives (value, ctx, patch) and mutates the live display. It does
 * NOT write CONFIG; the executor does that for every accepted key.
 *
 * `patch` is the WHOLE accepted patch, and exists for the handful of settings
 * that are only meaningful as a set -- a zoom range is a pair, and validating
 * one end against whatever the other end happens to be at that instant makes
 * the answer depend on which key the executor reached first. Such a handler
 * composes the final value from `patch` plus, for members not in this patch,
 * the current one from `defaultOf` (which reads live CONFIG). Every handler
 * that does this is idempotent by construction, because each member key
 * computes the SAME final value -- so running it once per member is harmless
 * and the accept/reject decision never depends on ordering.
 */

/** The value `path` will hold once this patch has been applied: what the patch
 *  sets, or what CONFIG currently holds when the patch says nothing about it.
 *  `defaultOf` reads config.js live, and the executor writes CONFIG only after
 *  a handler has run, so during a patch this is genuinely the current value. */
function finalValue(patch, path) {
  return Object.prototype.hasOwnProperty.call(patch, path)
    ? patch[path] : defaultOf(path);
}

/** The zoom range, composed whole from both ends however many of them this
 *  patch carries. Both member handlers call this and get the same answer, so
 *  the pair is validated against what it will actually become. */
function zoomPair(patch) {
  return [finalValue(patch, 'input.zoomRange.0'),
          finalValue(patch, 'input.zoomRange.1')];
}

/** Writing CONFIG is the whole of the work. classify.js reads cfg() per event
 *  rather than capturing it at import -- a couple of property lookups at this
 *  event rate -- so the next event already sees the new value and there is no
 *  live object to poke. Declared explicitly rather than left out of the table,
 *  because a missing entry is what createApplier refuses to build on. */
const configOnly = () => {};

/** `arcs.<cls>.<key>` for a whole class, in one line each.
 *
 *  The three keys in ARC_REBUILD_KEYS are baked into a slot's TubeGeometry when
 *  the arc spawns, so setSpec alone would show them only on arcs not yet drawn.
 *  Clearing the pool is what makes them visible within a frame -- and is why
 *  they are declared `rebuild` rather than `uniform`. See settings.js. */
function arcHandlers(cls, keys) {
  const out = {};
  for (const key of keys) {
    out[`arcs.${cls}.${key}`] = ARC_REBUILD_KEYS.includes(key)
      ? (v, ctx) => { ctx.arcs.setSpec(cls, key, v); ctx.arcs.rebuild(); }
      : (v, ctx) => ctx.arcs.setSpec(cls, key, v);
  }
  return out;
}

const ARC_KEYS = ['life', 'tube', 'colorAt', 'gain', 'speed', 'lift',
                  'maxRise', 'bloomScale'];
// The shape every color rule shares. `gain` is here because a rule that omits
// its own reads this one; the list must match settings.js's, which a test
// asserts by requiring every schema path to have a handler.
const HIGHLIGHT_KEYS = ['life', 'tube', 'gain', 'speed', 'lift', 'maxRise', 'bloomScale'];
// Shape of the curve, baked into geometry at spawn. Must match the `rebuild`
// strategies in settings.js; a test asserts the two lists agree.
export const ARC_REBUILD_KEYS = ['tube', 'lift', 'maxRise'];

/** The ten `layers` booleans, all one call. */
function layerHandlers(names) {
  const out = {};
  for (const name of names) {
    if (name === 'stars') out[`layers.${name}`] = (v, ctx) => ctx.stars.setVisible(v);
    // Clouds and lightning are their own objects, not one of the globe's
    // baked layers: both arrive over the network long after the globe is
    // built, clouds as a fetched field and lightning as a replayed feed.
    else if (name === 'clouds' || name === 'lightning') {
      out[`layers.${name}`] = (v, ctx) => ctx[name] && ctx[name].setVisible(v);
    } else out[`layers.${name}`] = (v, ctx) => ctx.globe.setLayer(name, v);
  }
  return out;
}

/** The twelve element colors. One generated handler each, because the schema
 *  paths and the element keys are the same vocabulary on purpose. */
function colorHandlers() {
  const out = {};
  const target = {
    coastline: (c, ctx, ex) => ctx.globe.setColor('coastline', c, ex),
    bordersWorld: (c, ctx, ex) => ctx.globe.setColor('bordersWorld', c, ex),
    admin1: (c, ctx, ex) => ctx.globe.setColor('admin1', c, ex),
    bordersWatched: (c, ctx, ex) => ctx.globe.setColor('bordersWatched', c, ex),
    countryFlash: (c, ctx, ex) => ctx.globe.setColor('countryFlash', c, ex),
    cities: (c, ctx, ex) => ctx.globe.setCityColor(ex ? c : null),
    atmosphere: (c, ctx) => ctx.atmosphere.setGlow(c),
    rippleFlow: (c, ctx, ex) => ctx.ripples.setColor('flow', c, ex),
    rippleBlock: (c, ctx, ex) => ctx.ripples.setColor('block', c, ex),
    rippleHighlight: (c, ctx, ex) => ctx.ripples.setColor('highlight', c, ex),
    auroraLow: (c, ctx, ex, patch) => setAurora(ctx, patch, c, null),
    auroraHigh: (c, ctx, ex, patch) => setAurora(ctx, patch, null, c),
  };
  for (const key of Object.keys(target)) {
    out[`appearance.colors.${key}`] = (v, ctx, patch) => {
      // resolveColor returns a HEX STRING -- elements.js is three-free so it can
      // be unit-tested. apply.js may import three, so the wrap happens here, once,
      // rather than in twelve module setters.
      target[key](new THREE.Color(resolveColor(key, v)), ctx, !isAuto(v), patch);
    };
  }
  return out;
}

/** The aurora takes both bands at once: its setter writes a pair, and a patch
 *  may carry one or both. Composed from the patch plus live CONFIG for the
 *  band this patch does not mention -- the same rule input.zoomRange follows,
 *  so running it once per band is idempotent and ordering cannot be observed. */
function setAurora(ctx, patch, low, high) {
  const lo = low || new THREE.Color(resolveColor('auroraLow',
    finalValue(patch, 'appearance.colors.auroraLow')));
  const hi = high || new THREE.Color(resolveColor('auroraHigh',
    finalValue(patch, 'appearance.colors.auroraHigh')));
  ctx.aurora.setColors(lo, hi);
}

export const HANDLERS = {
  'traffic.flowsPerSecond': (v, ctx) => ctx.arcs.setUniform('flowsPerSecond', v),
  'traffic.dropDns': configOnly,
  'traffic.dnsPorts': configOnly,
  'traffic.dropResolvers': configOnly,
  'traffic.resolvers': configOnly,
  'traffic.extraResolvers': configOnly,

  'arcs.bodyOpacity': (v, ctx) => ctx.arcs.setUniform('bodyOpacity', v),
  ...arcHandlers('flow', ARC_KEYS),
  ...arcHandlers('block', ARC_KEYS),
  ...arcHandlers('highlight', HIGHLIGHT_KEYS),
  // Every rule shares one geometry, so nothing is torn down: setRules pushes
  // color, gain and bloomScale into the arcs ALREADY IN THE AIR. Marking this
  // `rebuild` would clear the pool for no benefit and cost a pass.
  'arcs.rules': (v, ctx) => {
    ctx.arcs.setRules(v);
    if (ctx.classCounts) ctx.classCounts.setKeys(v.map(ruleKey));
  },

  'camera.distance': (v, ctx) => ctx.rig.setParam('camera.distance', v),
  'camera.walk.enabled': (v, ctx) => ctx.rig.setParam('camera.walk.enabled', v),
  'camera.walk.cycleSeconds': (v, ctx) => ctx.rig.setParam('camera.walk.cycleSeconds', v),
  'camera.walk.holdSeconds': (v, ctx) => ctx.rig.setParam('camera.walk.holdSeconds', v),
  'camera.walk.returnMaxSeconds': (v, ctx) => ctx.rig.setParam('camera.walk.returnMaxSeconds', v),
  'camera.walk.arriveDegrees': (v, ctx) => ctx.rig.setParam('camera.walk.arriveDegrees', v),
  'camera.walk.degreesPerSecond': (v, ctx) => ctx.rig.setParam('camera.walk.degreesPerSecond', v),
  'camera.walk.spanDegrees': (v, ctx) => ctx.rig.setParam('camera.walk.spanDegrees', v),
  'camera.walk.rampFloor': (v, ctx) => ctx.rig.setParam('camera.walk.rampFloor', v),
  'camera.walk.latitudeClamp': (v, ctx) => ctx.rig.setParam('camera.walk.latitudeClamp', v),
  'camera.detour.enabled': (v, ctx) => ctx.rig.setParam('camera.detour.enabled', v),
  'camera.detour.visitSeconds': (v, ctx) => ctx.rig.setParam('camera.detour.visitSeconds', v),
  'camera.detour.visitMaxSeconds': (v, ctx) => ctx.rig.setParam('camera.detour.visitMaxSeconds', v),
  'camera.detour.interruptManual': (v, ctx) => ctx.rig.setParam('camera.detour.interruptManual', v),
  // The detector's own thresholds, not the rig's: see the BURST import.
  'camera.detour.blocks': (v) => { BURST.count = v; },
  'camera.detour.withinSeconds': (v) => { BURST.windowSeconds = v; },
  'camera.detour.quietSeconds': (v) => { BURST.cooldownSeconds = v; },

  'input.enabled': (v, ctx) => ctx.input.setParam('input.enabled', v),
  'input.drag': (v, ctx) => ctx.input.setParam('input.drag', v),
  'input.zoom': (v, ctx) => ctx.input.setParam('input.zoom', v),
  'input.keyboard': (v, ctx) => ctx.input.setParam('input.keyboard', v),
  'input.zoomFactor': (v, ctx) => ctx.input.setParam('input.zoomFactor', v),
  'input.inertia': (v, ctx) => ctx.input.setParam('input.inertia', v),
  'input.invert': (v, ctx) => ctx.input.setParam('input.invert', v),
  'input.hideCursorSeconds': (v, ctx) => ctx.input.setParam('input.hideCursorSeconds', v),
  // createMenu reads cfg('input.lock') itself at open time rather than
  // holding a copy, so writing CONFIG is the whole of the work -- same as
  // the other configOnly entries above.
  'input.lock': configOnly,
  // createMenu reads cfg('menu.testMode') fresh on every open, same as
  // input.lock above -- flipping the mode itself never touches the live
  // display, only whether a later hover does.
  'menu.testMode': configOnly,
  // Owned by camera.js and campath.js, not by input.js: the zoom clamp, the
  // framing it returns to and the idle countdown all live with the rig.
  // A pair, never one end at a time. Both of these compose the same final pair
  // from the whole patch, so a two-sided shift is accepted or refused on what
  // it will become and not on key order -- and a refusal leaves both ends as
  // they were, because the rig validates before it assigns either.
  'input.zoomRange.0': (v, ctx, patch) => ctx.rig.setParam('input.zoomRange', zoomPair(patch)),
  'input.zoomRange.1': (v, ctx, patch) => ctx.rig.setParam('input.zoomRange', zoomPair(patch)),
  'input.zoomReturnEase': (v, ctx) => ctx.rig.setParam('input.zoomReturnEase', v),
  'input.rollReturnEase': (v, ctx) => ctx.rig.setParam('input.rollReturnEase', v),
  'input.resumeSeconds': (v, ctx) => ctx.rig.setParam('input.resumeSeconds', v),
  // Both halves: campath owns the countdown, input.js owns knowing which kind
  // of claim it is, so the value has to reach both or the menu keeps poking
  // with a stale delay.
  'input.menuResumeSeconds': (v, ctx) => {
    ctx.rig.setParam('input.menuResumeSeconds', v);
    ctx.input.setParam('input.menuResumeSeconds', v);
  },

  ...layerHandlers(['cityLights', 'coastline', 'bordersWatched', 'bordersWorld',
                    'admin1', 'stars', 'aurora', 'atmosphere', 'ripples',
                    'countryFlash', 'clouds', 'lightning']),

  'ripples.cooldownSeconds': (v, ctx) => ctx.ripples.setCooldown(v),

  'appearance.background': (v, ctx) => ctx.scene.background.set(v),
  'appearance.bloom.strength': (v, ctx) => ctx.post.setBloom('strength', v),
  'appearance.bloom.radius': (v, ctx) => ctx.post.setBloom('radius', v),
  'appearance.bloom.threshold': (v, ctx) => ctx.post.setBloom('threshold', v),
  'appearance.bloom.knee': (v, ctx) => ctx.post.setBloom('knee', v),
  'appearance.starBrightness': (v, ctx) => ctx.stars.setBrightness(v),
  'appearance.starDayGain': (v, ctx) => ctx.stars.setDayGain(v),
  'appearance.starRampMinutes': (v, ctx) => ctx.stars.setRampMinutes(v),

  // Every cloud row is a no-op when the layer never mounted -- no field
  // fetched, or a collector without one -- rather than a thrown handler that
  // would take the whole settings apply with it.
  'clouds.opacity': (v, ctx) => ctx.clouds && ctx.clouds.setUniform('opacity', v),
  'clouds.threshold': (v, ctx) => ctx.clouds && ctx.clouds.setUniform('threshold', v),
  'clouds.nightDim': (v, ctx) => ctx.clouds && ctx.clouds.setUniform('nightDim', v),
  'clouds.tint': (v, ctx) => ctx.clouds && ctx.clouds.setUniform('tint', v),

  // No-ops when the layer never mounted -- off at boot, or a collector that
  // serves no /lightning.json -- rather than a throw that would take the whole
  // settings apply with it. Same rule as the cloud rows.
  'lightning.flashLife': (v, ctx) => ctx.lightning && ctx.lightning.setUniform('flashLife', v),
  'lightning.glowLife': (v, ctx) => ctx.lightning && ctx.lightning.setUniform('glowLife', v),
  'lightning.size': (v, ctx) => ctx.lightning && ctx.lightning.setUniform('size', v),
  'lightning.brightness': (v, ctx) => ctx.lightning && ctx.lightning.setUniform('brightness', v),
  'lightning.color': (v, ctx) => ctx.lightning && ctx.lightning.setUniform('color', v),

  'rail.enabled': (v, ctx) => {
    if (v && !ctx.rail.mounted()) ctx.rail.mount();
    if (!v && ctx.rail.mounted()) ctx.rail.unmount();
  },
  'rail.maxRules': (v, ctx) => ctx.rail.setMaxRules(v),

  'polling.healthSeconds': (v, ctx) => ctx.polling('health', v),
  'polling.railSeconds': (v, ctx) => ctx.polling('rail', v),
  'polling.buildSeconds': (v, ctx) => ctx.polling('build', v),
  'polling.sunSeconds': (v, ctx) => ctx.polling('sun', v),
  'polling.starResyncSeconds': (v, ctx) => ctx.polling('starResync', v),

  ...colorHandlers(),
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
          HANDLERS[path](accepted[path], ctx, accepted);
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
