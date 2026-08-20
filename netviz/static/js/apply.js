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
// are never node-tested. apply.js is unlike them: it is both three-facing
// and unit-tested (apply.test.mjs and tuner.test.mjs already import it)
// under `node --test`, which has no import map and cannot see a bare
// 'three' at all. Both specifiers resolve to the SAME URL in the browser --
// index.html maps 'three' to /vendor/three/three.module.js, which is this
// file relative to it -- so there is no second three instance, only a
// second way to name the one that already exists. Do not "tidy" this back
// to the bare specifier; it would silently break `node --test`. Same fix,
// same reasoning, as palette.js.
import * as THREE from '../vendor/three/three.module.js';
import { validate, planApply, paths, defaultOf, entry, BUILTIN_THEMES }
  from './settings.js';
import { CONFIG } from './config.js';
import { resolveColor, isAuto, ELEMENT_T, ELEMENT_LITERAL } from './elements.js';
// THEME_SKIES lives in ramp.js, not here -- per-ramp data belongs with the
// ramps, and ramp.js is three-free so it can be imported under `node --test`.
// Do NOT define a second copy of this table; two copies of one table drift,
// and the drift shows up as a sky that is illegal on the wall.
import { setActiveRamp, THEME_SKIES } from './ramp.js';
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

// `color` is flow/block only; HIGHLIGHT_KEYS omits it because a color rule
// carries its own hex and a class-level color there would never be read.
const ARC_KEYS = ['life', 'tube', 'color', 'colorAt', 'gain', 'speed', 'lift',
                  'maxRise', 'bloomScale'];
// The shape every color rule shares. `gain` is here because a rule that omits
// its own reads this one; the list must match settings.js's, which a test
// asserts by requiring every schema path to have a handler.
const HIGHLIGHT_KEYS = ['life', 'tube', 'gain', 'speed', 'lift', 'maxRise', 'bloomScale'];
// Shape of the curve, baked into geometry at spawn. Must match the `rebuild`
// strategies in settings.js; a test asserts the two lists agree.
export const ARC_REBUILD_KEYS = ['tube', 'lift', 'maxRise'];

/** The thirteen `layers` booleans, all one call. */
function layerHandlers(names) {
  const out = {};
  for (const name of names) {
    if (name === 'stars') out[`layers.${name}`] = (v, ctx) => ctx.stars.setVisible(v);
    else if (name === 'milkyway') out[`layers.${name}`] = (v, ctx) => ctx.milkyway.setVisible(v);
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
    // The rail takes its colors as CSS custom properties. rail.js must not
    // learn what a three Color is -- it is three-free and unit-tested that
    // way, which is also why the arc legend's colors are handed to it as a
    // function called on every paint rather than as objects.
    railWordmark: (c, ctx) => ctx.rail.setColor('wordmark', c),
    railClock: (c, ctx) => ctx.rail.setColor('clock', c),
    railPanelTitle: (c, ctx) => ctx.rail.setColor('panel-title', c),
    railBig: (c, ctx) => ctx.rail.setColor('big', c),
    railLabel: (c, ctx) => ctx.rail.setColor('label', c),
    railValue: (c, ctx) => ctx.rail.setColor('value', c),
    railAlarm: (c, ctx) => ctx.rail.setColor('alarm', c),
    railBars: (c, ctx) => ctx.rail.setColor('bars', c),
  };
  for (const key of Object.keys(target)) {
    out[`appearance.colors.${key}`] = (v, ctx, patch) => {
      // resolveColor returns a HEX STRING -- elements.js is three-free so it can
      // be unit-tested. apply.js may import three, so the wrap happens here, once,
      // rather than in twenty module setters.
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

/** The theme fans out here so one function owns "what does the ramp look
 *  like right now" -- both `appearance.theme` and `appearance.customRamp`
 *  call it. A patch carrying BOTH keys runs it twice, once per member handler,
 *  the same shape as `input.zoomRange`: each call composes the same final
 *  value from the whole patch via `finalValue`/`defaultOf`, so a second run is
 *  idempotent and the executor's key order is never observable in the
 *  result. */
/** Which theme this display should actually be on, given what it asked for and
 *  what its library still holds.
 *
 *  THE CASE THIS EXISTS FOR is a stored setting naming a theme somebody later
 *  deleted. That patch is restored at boot, before anyone can answer a dialog,
 *  so it has to resolve to something sane rather than being refused and leaving
 *  the display uncolored. The substitution is reported rather than made
 *  silently: the panel surfaces it on the next open, the way a conversion does.
 *
 *  `custom` before the shipped default, because a saved theme's patch writes
 *  the ramp and the element colors too -- so the display is very likely already
 *  wearing the look whose NAME went missing, and dropping it to plasma would
 *  throw away colors that are still perfectly good. */
export function resolveTheme(id, { names = [], hasCustomPaths = false } = {}) {
  if (BUILTIN_THEMES.includes(id) || names.includes(id)) {
    return { id, substituted: false, why: null };
  }
  if (hasCustomPaths) {
    return { id: 'custom', substituted: true,
             why: `the saved theme "${id}" is gone; keeping its colors as Custom` };
  }
  return { id: 'plasma', substituted: true,
           why: `the saved theme "${id}" is gone; back to the netviz default` };
}

function applyTheme(id, ctx, patch) {
  // A SAVED NAME resolves to `custom` for ramp purposes: the theme's own stored
  // `appearance.customRamp` is what it wears, and there is no built-in ramp
  // under that name to look up.
  const named = !BUILTIN_THEMES.includes(id);
  const rampId = (id === 'custom' || named) ? finalValue(patch, 'appearance.customRamp') : id;
  setActiveRamp(rampId);
  for (const key of [...Object.keys(ELEMENT_T), ...Object.keys(ELEMENT_LITERAL)]) {
    const stored = finalValue(patch, `appearance.colors.${key}`);
    if (!isAuto(stored)) continue;          // an override holds
    // One element's setter can throw -- a layer that was off at boot, or an
    // atmosphere/ripples object that never mounted (see the guard pattern the
    // layer handlers above already use). That must not cost the rest of the
    // fan-out: the arc re-push and the sky assignment below still have to run,
    // or a theme change on a deployment missing one layer leaves the ramp half
    // applied on the wall with nothing telling the operator why.
    try {
      HANDLERS[`appearance.colors.${key}`](stored, ctx, patch);
    } catch (err) {
      console.warn(`netviz: theme could not recolor ${key} -- ${err.message}`);
    }
  }
  // Arcs already in the air hold the OLD ramp's color: an arc's color is
  // resolved from rampAt(colorAt) at spawn and copied into the slot's uniform.
  // Without this re-push a theme change leaves up to 18 seconds of stale block
  // arcs on screen -- block arcs live 18s and arrive rarely -- which reads as a
  // theme switch that half worked. setSpec already pushes colorAt into live
  // slots, so re-writing the same value is what forces the re-resolve.
  //
  // Only classes that actually DECLARE colorAt: `arcs.highlight` shares this
  // shape with flow/block (see HIGHLIGHT_KEYS above) but has no colorAt of
  // its own -- a rule carries its own hex instead -- so `entry()` returns
  // null for it and pushing anyway would write `defaultOf(...) === undefined`
  // into a live slot. Harmless today only because spec.hex is always set on a
  // highlight rule; it would throw inside rampHexAt(NaN) for a rule that
  // omits its color.
  for (const cls of ['flow', 'block', 'highlight']) {
    if (!entry(`arcs.${cls}.colorAt`)) continue;
    ctx.arcs.setSpec(cls, 'colorAt', defaultOf(`arcs.${cls}.colorAt`));
  }
  const sky = finalValue(patch, 'appearance.background');
  // A saved name has no sky of its own in THEME_SKIES either; its patch carries
  // an explicit `appearance.background` when it has one, and falls back to the
  // custom sky when it does not.
  if (isAuto(sky)) {
    ctx.scene.background = new THREE.Color(
      THEME_SKIES[id] || THEME_SKIES.custom || THEME_SKIES.plasma);
  }
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
  'arcs.custom': (v, ctx) => {
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
                    'admin1', 'stars', 'milkyway', 'aurora', 'atmosphere',
                    'ripples', 'countryFlash', 'clouds', 'lightning']),

  'ripples.cooldownSeconds': (v, ctx) => ctx.ripples.setCooldown(v),

  // `auto` follows the active theme's sky; an explicit hex holds against
  // future theme changes (see applyTheme, which checks this same value before
  // ever touching the sky).
  'appearance.background': (v, ctx) => {
    const theme = defaultOf('appearance.theme');
    ctx.scene.background.set(isAuto(v)
      ? (THEME_SKIES[theme] || THEME_SKIES.custom || THEME_SKIES.plasma) : v);
  },
  'appearance.theme': (v, ctx, patch) => applyTheme(v, ctx, patch),
  // Only meaningful when the theme is 'custom', but recomputing the whole
  // fan-out here rather than a narrower path keeps one function owning "what
  // does the ramp look like right now" -- see applyTheme.
  'appearance.customRamp': (v, ctx, patch) => applyTheme(defaultOf('appearance.theme'), ctx, patch),
  'appearance.bloom.strength': (v, ctx) => ctx.post.setBloom('strength', v),
  'appearance.bloom.radius': (v, ctx) => ctx.post.setBloom('radius', v),
  'appearance.bloom.threshold': (v, ctx) => ctx.post.setBloom('threshold', v),
  'appearance.bloom.knee': (v, ctx) => ctx.post.setBloom('knee', v),
  'appearance.starBrightness': (v, ctx) => ctx.stars.setBrightness(v),
  // The day ramp is the SKY's, not the stars': the band washes out in a lit
  // room for the same reason the stars do, and a sky that brightened at dawn
  // by two different curves is nobody's idea of correct.
  'appearance.starDayGain': (v, ctx) => {
    ctx.stars.setDayGain(v);
    ctx.milkyway.setDayGain(v);
  },
  'appearance.starRampMinutes': (v, ctx) => {
    ctx.stars.setRampMinutes(v);
    ctx.milkyway.setRampMinutes(v);
  },
  'appearance.milkyway.brightness': (v, ctx) => ctx.milkyway.setBrightness(v),
  'appearance.milkyway.dust': (v, ctx) => ctx.milkyway.setDust(v),
  'appearance.milkyway.clumping': (v, ctx) => ctx.milkyway.setClumping(v),
  'appearance.milkyway.exposure': (v, ctx) => ctx.milkyway.setExposure(v),
  'appearance.atmosphere.power': (v, ctx) => ctx.atmosphere.setParam('power', v),
  'appearance.atmosphere.strength': (v, ctx) => ctx.atmosphere.setParam('strength', v),
  'appearance.atmosphere.thickness': (v, ctx) => ctx.atmosphere.setThickness(v),
  'appearance.surface.softness': (v, ctx) => ctx.globe.setSurface('softness', v),
  'appearance.surface.dayAmbient': (v, ctx) => ctx.globe.setSurface('dayAmbient', v),
  'appearance.surface.dayTint': (v, ctx) =>
    ctx.globe.setSurface('dayTint', new THREE.Color(v)),
  'appearance.surface.nightTint': (v, ctx) =>
    ctx.globe.setSurface('nightTint', new THREE.Color(v)),

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
  // Each writes one custom property on #rail and re-fits. Declared `relayout`,
  // so the executor also calls resize() once however many of the five moved.
  'rail.scale.master': (v, ctx) => ctx.rail.setScale('master', v),
  'rail.scale.header': (v, ctx) => ctx.rail.setScale('header', v),
  'rail.scale.panel': (v, ctx) => ctx.rail.setScale('panel', v),
  'rail.scale.big': (v, ctx) => ctx.rail.setScale('big', v),
  'rail.scale.row': (v, ctx) => ctx.rail.setScale('row', v),

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
