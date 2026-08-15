// Real cloud cover, wrapped around the globe as an alpha mask.
//
// The collector fetches NOAA's hourly global geostationary mosaic and serves it
// at /clouds.png (see netviz/clouds.py); this draws it on a shell just above
// the surface. Same rule as the aurora: NO FIELD MEANS NO LAYER. A 404, a
// collector built without the dependency, a fetch that has never succeeded and
// a field too old to trust all end at the same place -- nothing drawn -- because
// "no clouds anywhere on Earth" is not a state worth inventing.
//
// THE TEXTURE IS NOT A FULL EQUIRECTANGULAR MAP, and treating it as one is the
// mistake that looks almost right. A geostationary satellite cannot see the
// poles, so the mosaic stops at +/-72.7 degrees: mapped straight onto
// SphereGeometry's uv it stretches ~145 degrees of weather across 180 and every
// front sits in the wrong place, worst near the poles and still wrong at the
// equator. The fragment shader converts uv.y to a real latitude, then back into
// the texture's own row space, and discards anything outside it.
import * as THREE from 'three';
import { cfg } from './config.js';
import { cloudFade, nextPollDelay, shouldPollNow } from './schedule.js';

// The granule's own bounds, from its CF attributes -- geospatial_lat_min /
// geospatial_lat_max on the live 20:00Z file, 2026-08-14. Constants rather than
// a fetch of the metadata: they are fixed by the satellite geometry, not by the
// hour, and a wrong pair here shows up as clouds in the wrong place rather than
// as an error.
const LAT_MIN = -72.7368;
const LAT_MAX = 72.7154;

// The collector fetches hourly at 45 past the hour, so the kiosk asks a few
// minutes after that rather than on its own arbitrary schedule. The retry floor
// is what stops a poll that failed at 20:48 from leaving the globe bare until
// 21:48 -- same reasoning as the aurora's.
const POLL_PERIOD_MS = 3600_000;
const POLL_OFFSET_MS = 48 * 60_000;
const RETRY_MS = 300_000;

// How recently a poll must have run for setVisible(true) to treat the field
// as "already being checked" and skip firing another one. 5s is generous
// against real network latency (the fetch itself, not this constant, is what
// takes time) and tiny against POLL_PERIOD_MS -- its only job is to collapse
// a burst of clicks on one toggle into at most one extra fetch.
const MIN_REPOLL_MS = 5000;

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D field;
  uniform vec3 sunDir;
  uniform vec3 tint;
  uniform float opacity;
  uniform float threshold;   // brightness below this is clear sky
  uniform float nightDim;    // how much of the day brightness survives at night
  uniform float fade;        // 0 while the field is stale or absent
  uniform float latMin;
  uniform float latMax;
  varying vec2 vUv;
  varying vec3 vNormalW;

  void main() {
    // uv.y runs 0 at the south pole to 1 at the north, so this is a real
    // latitude -- then remapped into the texture's own narrower band.
    float lat = (vUv.y - 0.5) * 180.0;
    float tv = (lat - latMin) / (latMax - latMin);
    if (tv < 0.0 || tv > 1.0) discard;    // beyond what the satellites see

    float d = texture2D(field, vec2(vUv.x, tv)).r;
    // Below the threshold is clear air, not thin cloud: the IR field has a
    // noise floor over open ocean, and mapping it linearly puts a grey haze
    // over the whole planet that reads as a dirty lens.
    float density = smoothstep(threshold, 1.0, d);
    if (density <= 0.0) discard;

    // Lit like the surface below it, from the same sunDir the terminator uses.
    // Not dropped to zero at night: clouds over a dark ocean still catch enough
    // light to be the difference between a globe and a black disc, and the
    // night side is where the city lights need something to sit under.
    float lit = smoothstep(-0.25, 0.25, dot(normalize(vNormalW), normalize(sunDir)));
    float shade = mix(nightDim, 1.0, lit);

    // Softened at the edge of the band so the layer ENDS rather than being cut
    // off in a straight line across the Arctic.
    float edge = min(smoothstep(0.0, 0.06, tv), smoothstep(1.0, 0.94, tv));

    gl_FragColor = vec4(tint * shade, density * opacity * shade * edge * fade);
  }
`;

/**
 * Mount the cloud shell.
 *
 * Returns null when the page has no business drawing one -- there is no useful
 * "empty clouds" object to hand back, and a caller that must null-check anyway
 * is better served by a null than by a mesh that draws nothing for ever.
 */
export function createClouds(radius) {
  const uniforms = {
    field: { value: null },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    tint: { value: new THREE.Color(cfg('clouds.tint', '#d9d7f0')) },
    opacity: { value: cfg('clouds.opacity', 0.42) },
    threshold: { value: cfg('clouds.threshold', 0.42) },
    nightDim: { value: cfg('clouds.nightDim', 0.30) },
    fade: { value: 0 },
    latMin: { value: LAT_MIN },
    latMax: { value: LAT_MAX },
  };

  // 1.004 rather than 1.0: coplanar with the surface it z-fights, and clouds
  // genuinely sit above the ground. Far below the atmosphere shell, which is
  // the limb glow and has to stay outside this.
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.004, 96, 64),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // No depth write: the arcs and the city sprites have to be visible
      // through a thin cloud rather than being culled by it.
      depthWrite: false,
    }),
  );
  mesh.visible = false;          // until a field actually arrives
  mesh.renderOrder = 1;

  let stopped = false;
  let timer = null;
  let texture = null;
  let etag = null;

  const loader = new THREE.TextureLoader();

  const loadField = () => new Promise((resolve) => {
    // Cache-busted by the collector's ETag rather than by a timestamp: the
    // field changes hourly, and a `?t=` on every poll would re-download 640 KB
    // to be handed the same bytes.
    loader.load('/clouds.png', (tex) => {
      tex.colorSpace = THREE.NoColorSpace;    // a mask, not a picture
      tex.wrapS = THREE.RepeatWrapping;       // longitude is cyclic
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if (texture) texture.dispose();
      texture = tex;
      uniforms.field.value = tex;
      resolve(true);
    }, undefined, () => resolve(false));
  });

  // Guards the immediate poll setVisible(true) triggers below. Without it,
  // rapid toggling (a menu row flipped a few times in a row, or apply()
  // replaying a whole settings patch that touches 'layers.clouds' more than
  // once) would fire one overlapping fetch per call -- on an unattended
  // display that never gets an operator to notice and stop, that is an
  // unbounded number of in-flight requests, not just a wasted one. `inFlight`
  // blocks a second call while one is already running; `lastPollAt` blocks a
  // burst of toggles that lands between polls (e.g. off/on/off/on within the
  // same second) from each queuing its own fetch once the first returns --
  // a poll less than a second old is treated as "already current" rather than
  // stale.
  let inFlight = false;
  let lastPollAt = 0;

  const poll = async () => {
    // The setting is read here, at the top of every poll, rather than gating
    // the mount in main.js: mounting is a one-time decision made before the
    // menu can touch anything, but whether to spend network on a fetch has to
    // track the live toggle, including a flip that happens mid-flight of the
    // previous poll's setTimeout wait. Reading it once at mount would freeze
    // the layer at whatever the boot config said, exactly the bug this task
    // removes.
    if (!cfg('layers.clouds', false)) {
      inFlight = false;
      if (!stopped) {
        timer = setTimeout(poll, nextPollDelay(Date.now(), POLL_PERIOD_MS, POLL_OFFSET_MS, true, RETRY_MS));
      }
      return;
    }
    inFlight = true;
    lastPollAt = Date.now();
    let ok = false;
    try {
      const r = await fetch('/clouds.json', { cache: 'no-store' });
      if (r.ok) {
        const state = await r.json();
        const fade = cloudFade(state.age, state.ttl);
        // The field is only re-fetched when the collector says it has a newer
        // one -- valid is the granule's coverage time, so this is "the weather
        // moved on", not "the page polled again".
        const stamp = String(state.valid);
        if (fade > 0 && stamp !== etag) {
          if (await loadField()) etag = stamp;
        }
        uniforms.fade.value = texture ? fade : 0;
        mesh.visible = uniforms.fade.value > 0 && cfg('layers.clouds', false);
        ok = true;
      } else {
        // 404: this collector has no cloud layer. Stop asking -- it cannot
        // start having one without a redeploy, and a redeploy reloads the page.
        uniforms.fade.value = 0;
        mesh.visible = false;
        if (r.status === 404) { inFlight = false; return; }
      }
    } catch {
      // A failed poll keeps the last field on the globe and lets it age out
      // through `fade`, exactly like a failed Kp fetch.
      ok = false;
    }
    inFlight = false;
    if (!stopped) timer = setTimeout(poll, nextPollDelay(Date.now(), POLL_PERIOD_MS, POLL_OFFSET_MS, ok, RETRY_MS));
  };

  poll();

  return {
    mesh,
    /** Sun direction in the globe group's local frame, same as the terminator. */
    update(sunLocal) {
      uniforms.sunDir.value.copy(sunLocal);
    },
    setVisible(v) {
      // Never shows a shell with no field in it: the setting says "draw clouds
      // if there are any", and there are not any until one has been fetched.
      mesh.visible = !!v && uniforms.fade.value > 0;
      // Turning the layer on with nothing to show yet must not wait for the
      // top of the hour (POLL_PERIOD_MS) or the next retry (RETRY_MS) -- that
      // is what makes a menu toggle read as broken. Only fires when there is
      // actually no usable field (fade <= 0); a layer switched back on while
      // its last fetch is still current draws that field immediately with no
      // network at all. Gated on inFlight and MIN_REPOLL_MS so that clicking
      // the toggle several times in one second -- or apply() replaying a
      // patch that touches this key more than once -- adds at most one extra
      // fetch, not one per click, on a display that runs unattended for
      // months and has nobody watching to notice a burst.
      const since = lastPollAt ? Date.now() - lastPollAt : Infinity;
      if (shouldPollNow(v, uniforms.fade.value > 0, inFlight, since, MIN_REPOLL_MS)) {
        // Deferred one tick (setTimeout 0), not called synchronously: apply.js
        // runs this handler and THEN writes CONFIG (createApplier's `run`
        // calls the handler before setConfig), so a synchronous poll() here
        // would read cfg('layers.clouds') a moment before apply.js's own
        // write lands and see the OLD value -- the disabled branch, no fetch,
        // silently defeating the whole point. A zero-delay timeout runs after
        // that synchronous write completes, in the very next turn.
        if (timer) clearTimeout(timer);
        timer = setTimeout(poll, 0);
      }
    },
    setUniform(name, value) {
      if (!(name in uniforms)) return;
      if (name === 'tint') uniforms.tint.value.set(value);
      else uniforms[name].value = value;
    },
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (texture) texture.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
