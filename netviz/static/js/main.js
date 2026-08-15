import * as THREE from 'three';
import { BACKGROUND } from './palette.js';
import { createGlobe, latLonToVec3 } from './globe.js';
import { sunDirection } from './sun.js';
import { createClouds } from './clouds.js';
import { createLightning } from './lightning.js';
import { createArcs } from './arcs.js';
import { cfg, CONFIG, loadServerConfig } from './config.js';
import { createRipples } from './ripples.js';
import { createAurora } from './aurora.js';
import { start as startDegraded } from './degraded.js';
import { createStars } from './stars.js';
import { createAtmosphere } from './atmosphere.js';
import { createComposer } from './post.js';
import { createCameraRig } from './camera.js';
import { startInput } from './input.js';
import { dnsSuppression, overrideClassFor, classNameFor, foreignEnd,
         rawRuleIndex } from './classify.js';
import { createBurstDetector } from './burst.js';
import { start as startRail } from './rail.js';
import { createClassCounter, ruleKey } from './classcount.js';
import { mountUpdateMark } from './update.js';
import { createApplier } from './apply.js';
import { createMenu } from './menu.js';
import { createRulesPanel } from './rules_panel.js';
import { createSettingsPanel } from './settings_panel.js';
import { createConfirm } from './confirm.js';
import { coerce, settingLabel } from './settings.js';
import { loadPatch, withPersistence, clearPatch } from './rulestore.js';

const GLOBE_RADIUS = 1.0;

// The subsolar point moves 0.004 deg/sec, so per-frame updates are pure waste.
// `let`, not a constant: polling.sunSeconds is a live setting.
let sunUpdateSeconds = cfg('polling.sunSeconds', 1.0);

const sunVec = new THREE.Vector3();
// Set in boot(); the sun updater runs before it exists on the very first call.
let aurora = null;
const sunLocal = new THREE.Vector3();
// Set at mount, always -- the field arrives over the network, so unlike the
// baked layers this one is not part of globe. Mounted unconditionally now
// (see boot() below): only null in the brief window before boot() runs.
let clouds = null;
// Set at mount, always -- like the clouds, the data arrives over the network
// rather than being baked into the globe. Mounted unconditionally, same
// reasoning as clouds.
let lightning = null;

// The globe group may rotate, so the sun vector has to be expressed in the
// group's local frame -- otherwise the terminator rides along with the
// rotation instead of staying fixed to real time.
function updateSun(globe, camera) {
  const now = new Date();
  const s = sunDirection(now);
  sunVec.set(s.x, s.y, s.z);
  sunLocal.copy(sunVec).applyQuaternion(globe.group.quaternion.clone().invert());
  globe.material.uniforms.sunDir.value.copy(sunLocal);
  if (globe.cityPoints) globe.cityPoints.material.uniforms.sunDir.value.copy(sunLocal);
  if (aurora) aurora.update(0, sunLocal);   // sun only; time advances in the loop
  if (clouds) clouds.update(sunLocal);      // lit by the same terminator
}

// How often the kiosk asks whether a new build has been deployed. Cheap: the
// response is a 16-char hash and the collector stats the static tree.
let buildPollSeconds = cfg('polling.buildSeconds', 30);

/** Reload the page when the deployed assets change.
 *
 *  A wall display nobody walks over to would otherwise keep running the JS it
 *  booted with until someone pressed F5. Failures are ignored on purpose --
 *  a fetch error means the collector is restarting, which is exactly when a
 *  reload would land on a closed port. */
function watchForNewBuild() {
  let known = null;
  // The same poll carries the release check: an update is available for days
  // once it is available at all, so it does not deserve a timer of its own.
  const showUpdate = mountUpdateMark();
  const check = async () => {
    try {
      const r = await fetch('/build.json', { cache: 'no-store' });
      if (!r.ok) return;
      const build = await r.json();
      showUpdate(build);
      const { stamp } = build;
      if (known === null) {
        known = stamp;
      } else if (stamp !== known) {
        console.info(`new build ${stamp} (was ${known}), reloading`);
        window.location.reload();
      }
    } catch (err) {
      // Collector down or mid-restart; try again on the next tick. The mark is
      // deliberately left as it was: a failed poll is not evidence the update
      // went away, and blinking it off and on every restart is the noise this
      // is supposed to avoid.
    }
  };
  check();
  let timer = setInterval(check, buildPollSeconds * 1000);
  return {
    setPeriod(seconds) {
      buildPollSeconds = seconds;
      clearInterval(timer);
      timer = setInterval(check, seconds * 1000);
    },
  };
}

function connect(onEvent) {
  let delay = 1000;
  // Read by degraded.js. `socket && OPEN` rather than a boolean flag so a
  // socket stuck mid-handshake counts as closed, which is what the wall wants.
  let socket = null;
  const open = () => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/`);
    socket = ws;
    ws.addEventListener('open', () => { delay = 1000; console.info('ws open'); });
    ws.addEventListener('message', (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch (err) {
        console.warn('bad ws message', err);   // counted by the console, dropped
      }
    });
    ws.addEventListener('close', () => {
      // Exponential backoff with jitter, 1s -> 30s. A kiosk that reconnects in
      // lockstep with a restarting collector hammers it; jitter avoids that.
      const wait = delay + Math.random() * 500;
      console.warn(`ws closed, retrying in ${Math.round(wait)}ms`);
      setTimeout(open, wait);
      delay = Math.min(delay * 2, 30000);
    });
    ws.addEventListener('error', () => ws.close());
  };
  open();
  return { isOpen: () => socket !== null && socket.readyState === WebSocket.OPEN };
}

async function boot() {
  const canvas = document.getElementById('scene');
  const stage = document.getElementById('stage');

  // Before anything reads a class color. The highlighted networks' prefixes
  // and colors are the collector's to know -- an address prefix describes
  // somebody's LAN, so it lives in .env rather than in tracked config.js --
  // and createArcs() freezes the class table when it is called.
  await loadServerConfig();

  // The PROPERTY access itself can throw, not just the methods: a managed
  // kiosk policy that disables DOM storage makes `window.localStorage` a
  // getter that raises SecurityError. rulestore's own calls are all guarded,
  // so a null here degrades to "this display remembers nothing" -- which is a
  // working display, and blanking the wall over a settings nicety is not.
  // Resolved once and reused at both call sites below, rather than reading
  // the property again at the second one.
  let storage = null;
  try {
    storage = window.localStorage;
  } catch (e) {
    console.warn(`netviz: settings storage unavailable -- ${e.message}`);
  }

  // What this display was told to remember, applied over config.js and over
  // whatever the collector just served. A stored EMPTY rule list wins too: it
  // means "this display has no rules", not "fall back to the environment".
  //
  // Applied through the same executor a runtime change uses, so a stored path
  // the schema no longer declares is reported and skipped rather than
  // reviving a setting that no longer exists. `settings` does not exist yet at
  // this point in boot, and two of the stored keys are needed before it does:
  // createArcs() below reads CONFIG.arcs.rules, and the rail-mount decision a
  // little further down (still before the first resize()) reads
  // CONFIG.rail.enabled -- both run long before createApplier() is called near
  // the end of boot(). So those two keys are written into CONFIG directly
  // here, validated through the same coerce() the executor would use.
  // Everything else in the stored patch (layers.*, camera.*, ...) is applied
  // through the executor once it exists, further down.
  const stored = loadPatch(storage);
  if (stored.error) console.warn(`netviz: ${stored.error}`);
  if (Object.prototype.hasOwnProperty.call(stored.patch, 'arcs.rules')) {
    const c = coerce('arcs.rules', stored.patch['arcs.rules']);
    if (c.ok) CONFIG.arcs.rules = c.value;
    else console.warn(`netviz: stored arcs.rules skipped -- ${c.why}`);
  }
  if (Object.prototype.hasOwnProperty.call(stored.patch, 'rail.enabled')) {
    const c = coerce('rail.enabled', stored.patch['rail.enabled']);
    if (c.ok) CONFIG.rail.enabled = c.value;
    else console.warn(`netviz: stored rail.enabled skipped -- ${c.why}`);
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);

  // Position and aim come from the rig every frame; nothing is set here.
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const rig = createCameraRig(camera, GLOBE_RADIUS);
  // Built once `settings` exists, near the bottom of boot() -- the menu needs
  // settings.apply() and startInput needs the menu. `input` is referenced by
  // the render loop below via closure, so declaring it here and assigning it
  // later is safe: the loop's callback cannot run before boot() has finished
  // running synchronously past the assignment.
  let input;

  const globe = await createGlobe(GLOBE_RADIUS);
  scene.add(globe.group);

  // In globe.group: the oval is fixed to the geomagnetic pole, which is fixed
  // to the Earth, so it must rotate with it.
  if (cfg('layers.aurora', true)) {
    aurora = createAurora(GLOBE_RADIUS);
    globe.group.add(aurora.mesh);
    // The handle, not the mesh: aurora.setVisible owns the decision, because
    // apply() recomputes mesh.visible from Kp on every poll.
    globe.registerLayer('aurora', aurora);
  }

  // In globe.group like the aurora: the field is fixed to the Earth's surface,
  // so it has to turn with it rather than hanging in front of the camera.
  //
  // Mounted unconditionally -- not behind cfg('layers.clouds') -- so the menu
  // row this task exists for has something live to flip. The boot-time guard
  // used to skip the poll loop entirely when the setting started false, which
  // left ctx.clouds null for ever and made apply.js's 'layers.clouds' handler
  // a permanent no-op: a control the operator could click with no effect on
  // the wall. clouds.js itself now reads the setting on every poll and skips
  // its fetch while off, so mounting always costs one object and zero network
  // when the layer is not wanted.
  clouds = createClouds(GLOBE_RADIUS);
  globe.group.add(clouds.mesh);
  // The handle, not the mesh: clouds.setVisible refuses to show a shell with
  // no field in it, which mesh.visible alone cannot know.
  globe.registerLayer('clouds', clouds);

  // In globe.group like the clouds: the strokes are fixed to the Earth's
  // surface, so they turn with it rather than hanging in front of the camera.
  //
  // Mounted unconditionally, same reasoning as clouds above: lightning.js
  // reads 'layers.lightning' itself on every poll and skips the fetch while
  // off, so a display that leaves lightning off (the default) still pays
  // nothing for it beyond one Points object with an empty pool.
  lightning = createLightning(GLOBE_RADIUS);
  globe.group.add(lightning.points);
  globe.registerLayer('lightning', lightning);

  // A disabled ripple layer still needs a spawn() to call, so the arc landing
  // callback below does not have to know whether it exists.
  // The stub carries the whole interface, as the stars stub does and as
  // input.js's used to: the render loop and the arc-landing callback both call
  // into it, and setCooldown is reachable from a settings patch. setCooldown
  // throws rather than no-opping, so `ripples.cooldownSeconds` on a build with
  // no ripple layer is REPORTED as rejected instead of appearing to work.
  const ripplesOff = () => {
    throw new Error('the ripple layer was off at boot and was never built; '
                  + 'set layers.ripples in config.js and reload');
  };
  const ripples = cfg('layers.ripples', true)
    ? createRipples(GLOBE_RADIUS)
    : { group: new THREE.Group(), spawn() {}, update() {}, setCooldown: ripplesOff };
  globe.group.add(ripples.group);   // ripples sit on the surface, so they rotate
  // Registered with the globe so `layers.*` has one toggle path rather than one
  // per module. A layer that was off at boot is not registered at all, and
  // setLayer says so instead of silently doing nothing.
  if (cfg('layers.ripples', true)) globe.registerLayer('ripples', ripples.group);

  // The ripple and the country flash both fire on arrival, not on receipt --
  // an arc that is still travelling has not landed yet.
  const arcs = createArcs(GLOBE_RADIUS, 220, (lat, lon, cls, country, color, bloomScale) => {
    ripples.spawn(lat, lon, cls, color, bloomScale);
    if (cls === 'block') globe.flashCountry(country);
  });
  globe.group.add(arcs.group);      // arcs rotate with the globe
  // DNS is dropped from the display, not from the collector: it is typically
  // 20-30% of events and a few percent of the bytes, and GeoLite2 has no city
  // record for anycast resolvers -- so it draws as a crowd of arcs converging
  // on one country-centroid point. Toggle with `traffic.dropDns` in config.js.
  // Influx still stores every DNS event: filtering at ingest would break the
  // byte history with nothing in the data marking the discontinuity.
  //
  // Past that filter, arcs.spawn samples flows at 14/sec for legibility;
  // blocks are never dropped.
  // A burst of blocks from one country sends the camera to go and look at it.
  // Fed on receipt rather than on arrival: the detour takes ~20s to fly out, so
  // starting it when the first arcs are still in the air means the camera gets
  // there while the burst is still on screen.
  const bursts = createBurstDetector();
  // Counted BEFORE arcs.spawn samples flows: arcs.js drops flows above
  // flowsPerSecond, and counting downstream of that would report the display's
  // own sampling rate rather than the network's traffic.
  const classCounts = createClassCounter();
  // A fresh kiosk is sent the replay window -- 60s of history -- as fast as the
  // socket will carry it, so every block in it lands inside a few milliseconds
  // and looks exactly like a burst. Measured on the deployed page: the camera
  // set off on a detour before the first frame was drawn. Events carry no
  // timestamp, so the drain cannot be dated; ignore bursts until it is over.
  const REPLAY_DRAIN_SECONDS = 5;
  const bootedAt = performance.now() / 1000;
  const link = connect((ev) => {
    // DNS is dropped UNLESS a rule is explicitly aimed at the reason it was
    // hidden -- a port matcher naming a DNS port, or an address matcher no
    // broader than the resolver-list entry that hid it. A rule broad enough to
    // have been written about something else does not qualify, or one country
    // rule would put the whole suppressed third of the feed back on the wall.
    // The overriding rule's own class is what the arc is drawn as: it is
    // handed to arcs.spawn, which would otherwise recompute it with
    // classNameFor -- the first rule that MERELY matches -- and draw the arc
    // in a broad rule's color while the rail counted it under the narrow one.
    const sups = dnsSuppression(ev);
    let overrideCls = null;
    if (sups.length) {
      overrideCls = overrideClassFor(ev, sups);
      if (!overrideCls) return;
    }
    const cls = overrideCls || classNameFor(ev);
    if (cls.startsWith('rule')) {
      // cls's index counts positions in the COMPILED rule list (refusals
      // dropped); the raw list here still carries them, so an unparseable
      // rule earlier in arcs.rules would otherwise shift every index after
      // it and the rail would count traffic under the wrong rule's key.
      const rule = cfg('arcs.rules', [])[rawRuleIndex(Number(cls.slice(4)) - 1)];
      if (rule) classCounts.add(ruleKey(rule), Date.now());
    }
    arcs.spawn(ev, cls, sups);
    if (cls === 'block') {
      // The blocked country is the FAR end, which on this router is the
      // destination: every geo policy here is outbound, so the source is a LAN
      // address at home. See foreignEnd in classify.js.
      const now = performance.now() / 1000;
      const far = now - bootedAt < REPLAY_DRAIN_SECONDS ? null : foreignEnd(ev);
      const hit = far && bursts.add(far.country, far.lat, far.lon, now);
      if (hit) {
        console.info(`block burst from ${hit.country}, visiting`);
        rig.visit(hit.lat, hit.lon);
      }
    }
  });

  const build = watchForNewBuild();
  const degraded = startDegraded({ isOpen: link.isOpen });

  // The stub carries the whole interface, as input.js's used to: main's render
  // loop calls into it every frame, and a missing method there stops the loop.
  // Its setters throw rather than no-op, so a settings patch that asks for
  // something a build without stars cannot do is REPORTED as rejected instead
  // of appearing to work.
  const starsOff = () => {
    throw new Error('stars were off at boot and the catalogue was never '
                  + 'fetched; set layers.stars in config.js and reload');
  };
  const stars = cfg('layers.stars', true)
    ? await createStars()
    : { group: new THREE.Group(), update() {}, setPixelScale() {},
        setBrightness: starsOff, setDayGain: starsOff, setRampMinutes: starsOff,
        setResync: starsOff, setVisible: starsOff };
  scene.add(stars.group);
  // not in globe.group: must not rotate
  if (cfg('layers.atmosphere', true)) {
    const atmosphere = createAtmosphere(GLOBE_RADIUS);
    scene.add(atmosphere);
    globe.registerLayer('atmosphere', atmosphere);
  }

  // Declared before resize() so the first resize -- which runs before the
  // composer exists -- reads null instead of hitting the const's temporal
  // dead zone and throwing.
  let composer = null;

  function resize() {
    // The stage, not the window: with the right rail on, the canvas owns only
    // 74% of the viewport, and sizing the drawing buffer to the window would
    // render the globe at the wrong aspect and push it off centre -- the same
    // failure mode as the old setSize(w, h, false) bug, arrived at from the
    // other direction. With the rail off, #stage is the full viewport and this
    // is identical to what it replaced.
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    // updateStyle stays ON. With it off the canvas gets no CSS size, so it lays
    // out at its intrinsic size -- w * devicePixelRatio CSS pixels. At dpr 1
    // (the wall) that matches the viewport; on a dpr 2 laptop the canvas is
    // twice the viewport, anchored top-left, and the globe renders zoomed and
    // off-centre with the overflow clipped.
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // City sprites are pixel-sized; keep them the same angular size at any
    // resolution (0.002 * height puts the largest city at ~6px on 1440p).
    if (globe.cityPoints) {
      globe.cityPoints.material.uniforms.pixelScale.value =
        renderer.domElement.height * 0.002;
    }
    if (lightning) lightning.setPixelScale(renderer.domElement.height * 0.002);
    // Stars are pixel-sized too. 1/1440 keeps a mag 6 star sub-pixel-ish and
    // Sirius a few pixels across at any resolution.
    stars.setPixelScale(renderer.domElement.height / 1440);
    if (composer) composer.setSize(w, h);
  }
  // Before the first resize(): mounting the rail narrows #stage, and reading
  // the stage box afterwards is what makes the globe fit the space it actually
  // has. Off by default -- see js/rail.js for why it is per-display and not a
  // build setting.
  //
  // The rail is mounted through the same path a settings change takes, so the
  // boot case and the toggle case cannot diverge.
  let railHandle = null;
  const rail = {
    mounted: () => railHandle !== null,
    mount() {
      if (railHandle) return;
      // No onLayout hook: the caller resizes. Boot calls resize() below and the
      // settings executor calls ctx.resize() after any relayout key, so letting
      // rail.js resize as well made mounting cost TWO resizes against
      // unmounting's one -- and a resize rebuilds the composer's render
      // targets, which is the whole reason the executor collapses them to one.
      // The legend's swatches come from the live arc specs, so the key on the
      // rail cannot drift from the arcs on the globe -- including after a
      // recolor through settings, which is why this is a function and not two
      // strings read once at mount.
      railHandle = startRail(classCounts, () => ({
        block: `#${arcs.classColor('block').getHexString()}`,
        flow: `#${arcs.classColor('flow').getHexString()}`,
      }), () => (lightning ? lightning.state() : null));
    },
    unmount() {
      if (!railHandle) return;
      railHandle.stop();
      railHandle = null;
    },
    // A number the rail reads on its next paint. No-op when the rail is not
    // mounted -- unlike the stars and aurora stubs, which throw, this one has
    // nothing to refuse: the value is stored in CONFIG by the executor and the
    // rail reads it when it next mounts.
    setMaxRules() {},
  };
  // One source, and it is already reconciled: the stored patch was applied
  // over config.js before this point, so cfg('rail.enabled') is what the menu
  // will show and what the display will have.
  if (cfg('rail.enabled', false)) rail.mount();

  window.addEventListener('resize', resize);
  resize();

  // WebGL context loss on a wall display that runs for months is a when, not
  // an if. Reloading is the only reliable recovery and costs nothing here.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('webgl context lost, reloading');
    window.location.reload();
  });

  // Manual dt rather than THREE.Clock: Clock is deprecated in 0.185 and warns
  // on every load, which would bury real console errors in tools/shoot.py.
  // After resize() has run once, so the bloom targets start at canvas size.
  composer = createComposer(renderer, scene, camera);

  updateSun(globe, camera);
  let sinceSun = 0;

  let last = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - last);   // clamp: a backgrounded tab must not jump
    last = now;
    arcs.update(dt);
    ripples.update(dt);
    if (lightning) lightning.update(dt);
    if (aurora) aurora.mesh.material.uniforms.time.value += dt;
    globe.updateFlashes(dt);
    stars.update(dt);
    input.tick(dt);
    rig.update(dt, arcs.origins());
    sinceSun += dt;
    if (sinceSun >= sunUpdateSeconds) {
      sinceSun = 0;
      updateSun(globe, camera);
    }
    composer.render();
  });

  // No setConfig here: the page wants the real one, which writes CONFIG so
  // anything reading cfg() later agrees with what is on screen. Passing a stub
  // would silently make every applied setting forget itself.
  // One place that knows which timer owns which polling setting, so apply.js
  // holds five one-line handlers rather than five module references.
  const polling = (key, seconds) => {
    if (key === 'health') degraded.setPeriod(seconds);
    else if (key === 'rail') { if (railHandle) railHandle.setPeriod(seconds); }
    else if (key === 'build') build.setPeriod(seconds);
    else if (key === 'sun') sunUpdateSeconds = seconds;
    else if (key === 'starResync') stars.setResync(seconds);
    else throw new Error(`no polling timer ${key}`);
  };

  // ctx is a real object, not a literal captured by value: settings.apply()
  // reads ctx.input at call time, so patching ctx.input below -- once input
  // actually exists -- is enough. createMenu needs `settings` itself, and
  // startInput needs the menu, so the order has to be settings -> menu ->
  // input, with input's slot in ctx filled in last.
  const ctx = {
    arcs, globe, stars, post: composer, ripples, camera, rig, renderer,
    scene, input: null, polling, resize, rail, classCounts, clouds, lightning,
  };
  // TWO appliers, on purpose. `preview` is the raw executor: the tuning panel
  // drives it while somebody drags a slider, so the wall changes and NOTHING
  // is stored -- a reload is the escape hatch that makes experimenting free.
  // `settings` is the same executor with persistence around it, and is what
  // the menu, the rules panel and the stored-patch replay use.
  const preview = createApplier(ctx);
  let settings = withPersistence(preview, storage);
  ctx.settings = settings;
  // The menu mounts on `body`, NOT on `#stage`. `#stage` is `position:
  // fixed`, which creates a stacking context, so a menu inside it ranks its
  // z-index only among stage's own children -- and `#rail` is a later
  // sibling of `#stage`, so the rail's numbers painted straight over the
  // menu's opaque background and it read as transparent. Raising the menu's
  // z-index cannot fix that (measured: 9999 changed nothing).
  const rulesPanel = createRulesPanel({ settings, root: document.body });
  // Same mount argument as the rules panel: document.body, never #stage.
  //
  // onLayout is resize(), and the panel calls it exactly once per toggle. The
  // panel is a LEFT RAIL now -- `body.tuner` narrows #stage the way `body.rail`
  // does -- so the drawing buffer has to follow, or the globe renders at the
  // full viewport's aspect inside a narrower box. One call per direction, for
  // the same reason rail.mount() leaves the resize to its caller: a relayout
  // rebuilds the composer's render targets.
  //
  // ONE confirm dialog on the page, built here because two callers need it: the
  // tuning panel's Keep/Revert/Close and "Reset to netviz defaults" below. A
  // second instance would be a second implementation of which button is the
  // safe one, and confirm.js's "only one at a time" guard is per-instance --
  // two of them could stack two dialogs whose buttons then disagree about which
  // is on top. Each caller still decides its OWN words; only the dialog is
  // shared.
  const confirmer = createConfirm({ root: document.body });
  const settingsPanel = createSettingsPanel({
    preview, storage, root: document.body, onLayout: resize, confirmer,
  });
  // "Reset to netviz defaults": drop every remembered setting EXCEPT the color
  // rules, then reload so config.js and /config.json decide again from the
  // top. The rules are kept because they are the operator's own work -- this
  // control is about the display's appearance, and a person resetting the
  // layers back to stock is not asking to lose a list they typed. Deleting
  // them is still one click away, per row, in the panel that owns them.
  //
  // A reload rather than an in-place re-apply: /config.json and the
  // NETVIZ_HIGHLIGHT* migration run at boot, so there is no path that restores
  // them mid-session, and half-restored settings would be worse than a
  // one-second reload on a wall.
  //
  // It asks first, and the question is built from what is ACTUALLY STORED
  // rather than from a fixed sentence: the dialog names the settings this
  // display would lose, so "what does this do" is answered for this screen
  // instead of in general. With nothing stored but rules, there is nothing to
  // reset and the dialog says exactly that with one button -- a yes/no over an
  // action that would change nothing teaches that Yes does nothing.
  const onReset = storage ? () => {
    const held = loadPatch(storage).patch || {};
    const losing = Object.keys(held).filter((p) => p !== 'arcs.rules');
    const ruleCount = Array.isArray(held['arcs.rules']) ? held['arcs.rules'].length : 0;
    confirmer.ask({
      title: 'Reset this display to netviz defaults?',
      lead: 'This affects only this screen, in this web browser. Nothing is '
          + 'sent to the collector and no other display changes.',
      will: losing.length ? [
        `Forget ${losing.length} setting${losing.length === 1 ? '' : 's'} you `
          + `changed on this screen: ${losing.map(settingLabel).join(', ')}.`,
        'Put those back to the values netviz ships with.',
        'Reload the page, which takes a second or two.',
      ] : [],
      wont: [
        ruleCount
          ? `Touch your ${ruleCount} color rule${ruleCount === 1 ? '' : 's'} -- they stay exactly as they are.`
          : 'Touch your color rules -- they are kept.',
        'Change anything on the collector, or on any other display.',
        'Delete any traffic, history or statistics.',
      ],
      note: losing.length
        ? 'To change the color rules instead, use "Color rules..." in this menu.'
        : 'Nothing to reset: this display is already running netviz defaults '
          + '(your color rules are not affected either way).',
      confirmLabel: 'Yes, reset this display',
      cancelLabel: 'No, leave it alone',
      onConfirm: () => {
        const out = clearPatch(storage, ['arcs.rules']);
        if (!out.ok) { console.warn(`netviz: ${out.error}`); return; }
        window.location.reload();
      },
    });
  } : null;
  const menu = createMenu({
    rig, settings, preview, rulesPanel, settingsPanel, onReset, root: document.body,
  });
  input = startInput({ canvas: renderer.domElement, rig, menu, rulesPanel, settingsPanel });
  ctx.input = input;
  // The rest of the stored patch (arcs.rules and rail.enabled were already
  // applied directly to CONFIG above, before createArcs() and the rail-mount
  // decision needed them -- see the comments there). Re-running the whole
  // patch through the executor here is harmless (setRules and rail.mount are
  // both idempotent) and is what reports a rejection for any OTHER stored key
  // the schema no longer knows. This must run AFTER ctx.input is set: eight
  // apply.js handlers dereference ctx.input and throw otherwise, which sent
  // every persisted input.* setting to `rejected` on every single boot.
  if (Object.keys(stored.patch).length) {
    const out = settings.apply(stored.patch);
    for (const r of out.rejected) {
      console.warn(`netviz: stored setting ${r.path} skipped -- ${r.why}`);
    }
  }

  // Diagnostics only -- no interaction, nothing reads this on the wall. It
  // exists so tools/shoot.py can assert the scene has live arcs rather than
  // leaving "looks about right" as the only check.
  window.__netviz = {
    arcs, globe, ripples, aurora, clouds, lightning, renderer, camera, scene, rig, stars, input,
    settings, menu, rulesPanel, settingsPanel,
    /** Screen position of a lat/lon, for verification tooling. Returns null
     *  when the point is on the far side of the globe. */
    project(lat, lon) {
      const v = latLonToVec3(lat, lon, GLOBE_RADIUS);
      const toCam = camera.position.clone().sub(v);
      if (v.dot(toCam) < 0) return null;        // behind the limb
      const p = v.clone().project(camera);
      return { x: Math.round((p.x + 1) / 2 * renderer.domElement.width),
               y: Math.round((1 - p.y) / 2 * renderer.domElement.height) };
    },
  };

  // Set only after textures and buffers have loaded, so tools/shoot.py waits
  // for a scene that actually has something in it.
  window.__netvizReady = true;
}

boot();
