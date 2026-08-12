import * as THREE from 'three';
import { BACKGROUND } from './palette.js';
import { createGlobe, latLonToVec3 } from './globe.js';
import { sunDirection } from './sun.js';
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
import { isDns, classNameFor, foreignEnd } from './classify.js';
import { createBurstDetector } from './burst.js';
import { start as startRail } from './rail.js';
import { createClassCounter, ruleKey } from './classcount.js';
import { mountUpdateMark } from './update.js';
import { createApplier } from './apply.js';
import { createMenu } from './menu.js';
import { createRulesPanel } from './rules_panel.js';
import { coerce } from './settings.js';
import { loadPatch, withPersistence } from './rulestore.js';

const GLOBE_RADIUS = 1.0;

// The subsolar point moves 0.004 deg/sec, so per-frame updates are pure waste.
// `let`, not a constant: polling.sunSeconds is a live setting.
let sunUpdateSeconds = cfg('polling.sunSeconds', 1.0);

const sunVec = new THREE.Vector3();
// Set in boot(); the sun updater runs before it exists on the very first call.
let aurora = null;
const sunLocal = new THREE.Vector3();

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

  // Before anything reads a class colour. The highlighted networks' prefixes
  // and colours are the collector's to know -- an address prefix describes
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
  const arcs = createArcs(GLOBE_RADIUS, 220, (lat, lon, cls, country, colour, bloomScale) => {
    ripples.spawn(lat, lon, cls, colour, bloomScale);
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
    if (isDns(ev)) return;
    const cls = classNameFor(ev);
    if (cls.startsWith('rule')) {
      const rule = cfg('arcs.rules', [])[Number(cls.slice(4)) - 1];
      if (rule) classCounts.add(ruleKey(rule), Date.now());
    }
    arcs.spawn(ev);
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
      railHandle = startRail(classCounts);
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
    scene, input: null, polling, resize, rail, classCounts,
  };
  let settings = createApplier(ctx);
  settings = withPersistence(settings, storage);
  // The rest of the stored patch (arcs.rules and rail.enabled were already
  // applied directly to CONFIG above, before createArcs() and the rail-mount
  // decision needed them -- see the comments there). Re-running the whole
  // patch through the executor here is harmless (setRules and rail.mount are
  // both idempotent) and is what reports a rejection for any OTHER stored key
  // the schema no longer knows.
  if (Object.keys(stored.patch).length) {
    const out = settings.apply(stored.patch);
    for (const r of out.rejected) {
      console.warn(`netviz: stored setting ${r.path} skipped -- ${r.why}`);
    }
  }
  ctx.settings = settings;
  // The menu mounts on `body`, NOT on `#stage`. `#stage` is `position:
  // fixed`, which creates a stacking context, so a menu inside it ranks its
  // z-index only among stage's own children -- and `#rail` is a later
  // sibling of `#stage`, so the rail's numbers painted straight over the
  // menu's opaque background and it read as transparent. Raising the menu's
  // z-index cannot fix that (measured: 9999 changed nothing).
  const rulesPanel = createRulesPanel({ settings, root: document.body });
  const menu = createMenu({ rig, settings, rulesPanel, root: document.body });
  input = startInput({ canvas: renderer.domElement, rig, menu });
  ctx.input = input;

  // Diagnostics only -- no interaction, nothing reads this on the wall. It
  // exists so tools/shoot.py can assert the scene has live arcs rather than
  // leaving "looks about right" as the only check.
  window.__netviz = {
    arcs, globe, ripples, aurora, renderer, camera, scene, rig, stars, input,
    settings, menu,
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
