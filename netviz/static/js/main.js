import * as THREE from 'three';
import { BACKGROUND } from './palette.js';
import { createGlobe, latLonToVec3 } from './globe.js';
import { sunDirection } from './sun.js';
import { createArcs } from './arcs.js';
import { cfg, loadServerConfig } from './config.js';
import { createRipples } from './ripples.js';
import { createAurora } from './aurora.js';
import { start as startDegraded } from './degraded.js';
import { createStars } from './stars.js';
import { createAtmosphere } from './atmosphere.js';
import { createComposer } from './post.js';
import { createCameraRig } from './camera.js';
import { isDns, classNameFor, foreignEnd } from './classify.js';
import { createBurstDetector } from './burst.js';
import { railEnabled, start as startRail } from './rail.js';

const GLOBE_RADIUS = 1.0;

// The subsolar point moves 0.004 deg/sec, so per-frame updates are pure waste.
const SUN_UPDATE_SECONDS = cfg('polling.sunSeconds', 1.0);

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
const BUILD_POLL_SECONDS = cfg('polling.buildSeconds', 30);

/** Reload the page when the deployed assets change.
 *
 *  A wall display nobody walks over to would otherwise keep running the JS it
 *  booted with until someone pressed F5. Failures are ignored on purpose --
 *  a fetch error means the collector is restarting, which is exactly when a
 *  reload would land on a closed port. */
function watchForNewBuild() {
  let known = null;
  const check = async () => {
    try {
      const r = await fetch('/build.json', { cache: 'no-store' });
      if (!r.ok) return;
      const { stamp } = await r.json();
      if (known === null) {
        known = stamp;
      } else if (stamp !== known) {
        console.info(`new build ${stamp} (was ${known}), reloading`);
        window.location.reload();
      }
    } catch (err) {
      // Collector down or mid-restart; try again on the next tick.
    }
  };
  check();
  setInterval(check, BUILD_POLL_SECONDS * 1000);
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);

  // Position and aim come from the rig every frame; nothing is set here.
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const rig = createCameraRig(camera, GLOBE_RADIUS);

  const globe = await createGlobe(GLOBE_RADIUS);
  scene.add(globe.group);

  // In globe.group: the oval is fixed to the geomagnetic pole, which is fixed
  // to the Earth, so it must rotate with it.
  if (cfg('layers.aurora', true)) {
    aurora = createAurora(GLOBE_RADIUS);
    globe.group.add(aurora.mesh);
  }

  // A disabled ripple layer still needs a spawn() to call, so the arc landing
  // callback below does not have to know whether it exists.
  const ripples = cfg('layers.ripples', true)
    ? createRipples(GLOBE_RADIUS)
    : { group: new THREE.Group(), spawn() {}, update() {} };
  globe.group.add(ripples.group);   // ripples sit on the surface, so they rotate

  // The ripple and the country flash both fire on arrival, not on receipt --
  // an arc that is still travelling has not landed yet.
  const arcs = createArcs(GLOBE_RADIUS, 220, (lat, lon, cls, country) => {
    ripples.spawn(lat, lon, cls);
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
  // A fresh kiosk is sent the replay window -- 60s of history -- as fast as the
  // socket will carry it, so every block in it lands inside a few milliseconds
  // and looks exactly like a burst. Measured on the deployed page: the camera
  // set off on a detour before the first frame was drawn. Events carry no
  // timestamp, so the drain cannot be dated; ignore bursts until it is over.
  const REPLAY_DRAIN_SECONDS = 5;
  const bootedAt = performance.now() / 1000;
  const link = connect((ev) => {
    if (isDns(ev)) return;
    arcs.spawn(ev);
    if (classNameFor(ev) === 'block') {
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

  watchForNewBuild();
  startDegraded({ isOpen: link.isOpen });

  const stars = cfg('layers.stars', true)
    ? await createStars()
    : { group: new THREE.Group(), update() {}, setPixelScale() {} };
  scene.add(stars.group);
  // not in globe.group: must not rotate
  if (cfg('layers.atmosphere', true)) scene.add(createAtmosphere(GLOBE_RADIUS));

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
  // has. Off by default -- see js/rail.js for why it is per-URL and not a build
  // setting.
  if (railEnabled(window.location.search)) startRail();

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
    rig.update(dt, arcs.origins());
    sinceSun += dt;
    if (sinceSun >= SUN_UPDATE_SECONDS) {
      sinceSun = 0;
      updateSun(globe, camera);
    }
    composer.render();
  });

  // Diagnostics only -- no interaction, nothing reads this on the wall. It
  // exists so tools/shoot.py can assert the scene has live arcs rather than
  // leaving "looks about right" as the only check.
  window.__netviz = {
    arcs, globe, ripples, aurora, renderer, camera, scene, rig, stars,
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
