// Real lightning, replayed at 1x about forty minutes behind the world.
//
// The collector holds one 10-minute bucket of Blitzortung strokes and serves it
// at /lightning.json (see netviz/lightning.py); this plays it back at real
// speed, so a storm cell pulses and drifts the way it actually did. A bucket
// covers 600 seconds and the next one lands 600 seconds later, so playback
// consumes buckets exactly as fast as they are published -- the wall stays a
// constant ~40 minutes behind with no drift and no gap.
//
// UNLIKE THE CLOUDS, AN EMPTY SKY IS TRUTHFUL. clouds.js fades rather than
// stopping because "no clouds anywhere on Earth" is never true; here, "no
// strokes right now" is a real and common state, so a bucket that plays out
// with no replacement simply draws nothing. Same rule as the aurora.
//
// The far-side cull is a dot product, NOT a depth test. Point sprites do not
// depth-test cleanly against the sphere at the limb -- the failure is a rim of
// strikes visibly floating past the edge of the planet, which reads as a bug in
// the projection rather than as weather.
import * as THREE from 'three';
import { cfg } from './config.js';
import { latLonToVec3 } from './globe.js';
import { nextLightningPoll, strokesDue, playbackStart, shouldPollNow } from './schedule.js';

// 11.5 strokes/second worldwide (measured) times a ~3.2s total life is about 37
// alive at once. 2048 is fifty times that: the pool exists so nothing allocates
// per stroke on a display that runs for months, not because the bound is tight.
const POOL = 2048;

const RETRY_MS = 120_000;

// How recently a poll must have run for setVisible(true) to treat the layer
// as "already being checked" and skip firing another one -- same role as
// clouds.js's constant of the same name, sized the same way: generous
// against real fetch latency, tiny against the ten-minute schedule, only
// there to collapse a burst of toggles into at most one extra request.
const MIN_REPOLL_MS = 5000;

// Fallback only: a renderer talking to a collector old enough not to serve
// `state.lag` yet still needs a number. netviz/lightning.py now serves this
// as PUBLISH_LAG so there is exactly one definition instead of the two that
// silently drifted into the boot-race bug documented in schedule.js.
const DEFAULT_LAG_SEC = 32 * 60;

// Float32 birth timestamps lose precision as the shared `now` clock grows: at
// ~2.6M seconds (roughly one month of uptime, and this kiosk only reloads on
// a deploy, so a month is ordinary) the ULP is about 0.25s -- bigger than
// flashLife's default of 0.22s, so the flash quantizes away entirely. Folding
// the clock and every live birth back by an hour, hourly, keeps every
// (now - birth) difference exact while never letting the magnitude grow
// enough to matter. arcs.js, ripples.js and globe.js sidestep this the same
// way clouds.js sidesteps a similar problem: a per-slot age reset to 0. This
// module can't do that -- `now` is one shared uniform, not per-slot -- so it
// gets its own periodic rebase instead.
const CLOCK_FOLD_SEC = 3600;

const VERT = /* glsl */`
  uniform float now;
  uniform float flashLife;
  uniform float glowLife;
  uniform float size;
  uniform float pixelScale;
  attribute float birth;
  varying float vAge;
  varying float vFacing;
  void main() {
    vAge = now - birth;
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    // The point sits on the sphere, so its outward normal is its own position.
    vec3 n = normalize(normalMatrix * normalize(position));
    vFacing = dot(n, normalize(-viewPos.xyz));
    // The flash is bigger than the afterglow: a strike should announce itself
    // and then leave a mark, not pulse at one width.
    float t = clamp(vAge / max(flashLife, 0.0001), 0.0, 1.0);
    float scale = mix(2.2, 1.0, t);
    gl_PointSize = size * scale * pixelScale;
    gl_Position = projectionMatrix * viewPos;
  }
`;

const FRAG = /* glsl */`
  uniform vec3 color;
  uniform float flashLife;
  uniform float glowLife;
  uniform float brightness;
  varying float vAge;
  varying float vFacing;
  void main() {
    // Behind the planet. Discarded rather than dimmed: a half-visible strike
    // at the limb is the artifact this whole cull exists to remove.
    if (vFacing <= 0.0) discard;
    if (vAge < 0.0 || vAge > glowLife) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float disc = 1.0 - smoothstep(0.2, 1.0, d);
    // Two decays summed, not blended: the flash is the event and the afterglow
    // is what lets a cell accumulate a footprint. With the flash alone, 11.5
    // strokes a second over a whole planet averages about two lit pixels, which
    // reads as sensor noise rather than as weather.
    float flash = 1.0 - smoothstep(0.0, flashLife, vAge);
    float glow = (1.0 - smoothstep(0.0, glowLife, vAge)) * 0.28;
    gl_FragColor = vec4(color, disc * (flash + glow) * brightness);
  }
`;

export function createLightning(radius) {
  const positions = new Float32Array(POOL * 3);
  const births = new Float32Array(POOL);
  births.fill(-1e6);                       // nothing alive at boot

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('birth', new THREE.BufferAttribute(births, 1));

  const uniforms = {
    now: { value: 0 },
    flashLife: { value: cfg('lightning.flashLife', 0.22) },
    glowLife: { value: cfg('lightning.glowLife', 3.2) },
    size: { value: cfg('lightning.size', 2.6) },
    brightness: { value: cfg('lightning.brightness', 1.0) },
    color: { value: new THREE.Color(cfg('lightning.color', '#cfe6ff')) },
    pixelScale: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;

  let head = 0;               // next pool slot
  let clock = 0;              // seconds since mount, the shader's `now`
  let strokes = [];           // the playing bucket
  let playAt = 0;             // playback position within the bucket, seconds
  let cursor = 0;             // index into `strokes`, carried across frames
  let bucket = null;
  let count = 0;
  let age = null;
  let timer = null;
  let stopped = false;
  let inFlight = false;         // guards setVisible's immediate poll below
  let lastPollAt = 0;           // ditto

  function spawn(lat, lon) {
    // latLonToVec3 owns the trig, including theta = -lon. Re-deriving it here
    // mirrors every storm and looks entirely plausible until you know a coast.
    // It returns a fresh Vector3 rather than writing into one we pass in --
    // that is its real signature (see globe.js) -- so the allocation happens
    // once per stroke event (~11.5/s), not per frame; the fixed-size pool below
    // is what keeps the per-frame cost flat.
    const v = latLonToVec3(lat, lon, radius * 1.002);
    const i = head;
    head = (head + 1) % POOL;
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    births[i] = clock;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.birth.needsUpdate = true;
  }

  // Visibility is recomputed from scratch on every poll outcome (new bucket,
  // empty bucket, 404, or a failed fetch that leaves the last state standing)
  // rather than being set once at mount, because `points.visible = false` at
  // construction is otherwise a dead end: nothing else in this module ever
  // flips it back. The rule mirrors clouds.js's `mesh.visible` line -- the
  // setting says "draw lightning if there is any", and there is not any until
  // a bucket has actually been fetched and it is nonempty.
  function refreshVisibility() {
    points.visible = cfg('layers.lightning', false) && strokes.length > 0;
  }

  const poll = async () => {
    // Read here, at the top of every poll, rather than gating the mount in
    // main.js: the mount is a one-time decision made before the menu exists,
    // but whether to spend network on a fetch has to track the live toggle,
    // including a flip that lands mid-flight of the previous poll's
    // setTimeout wait. The held bucket/strokes/age are left untouched while
    // off -- turning the layer back on with the same bucket still current
    // must redraw it, not discover it has been quietly cleared.
    if (!cfg('layers.lightning', false)) {
      inFlight = false;
      if (!stopped) timer = setTimeout(poll, nextLightningPoll(Date.now(), true, RETRY_MS));
      return;
    }
    inFlight = true;
    lastPollAt = Date.now();
    let ok = false;
    try {
      const r = await fetch('/lightning.json', { cache: 'no-store' });
      if (r.ok) {
        const state = await r.json();
        ok = true;
        if (state.bucket && state.bucket !== bucket) {
          // Playback starts where the bucket already is, not at 0: the poll may
          // land a minute late, and starting at 0 every time would replay that
          // minute and then run past the next bucket's arrival.
          const lag = state.lag ?? DEFAULT_LAG_SEC;
          const start = playbackStart(state.age, lag, state.window || 600);
          if (start === null) {
            // Belt-and-braces guard against the boot-race bug (see
            // LIGHTNING_OFFSET_MS in schedule.js): a bucket that is already
            // spent by the time it is fetched must never be adopted -- doing
            // so would clamp playAt to `window` and then never fire another
            // stroke for the full next 600s. Treat this poll as unhealthy
            // instead, so the poller retries on RETRY_MS and finds a live
            // bucket within two minutes rather than waiting out a dead one.
            ok = false;
          } else {
            bucket = state.bucket;
            strokes = Array.isArray(state.strokes) ? state.strokes : [];
            count = strokes.length;
            playAt = start;
            cursor = 0;
            age = state.age;
          }
        } else if (!state.bucket) {
          // The collector is up and has nothing yet -- e.g. it just restarted
          // and hasn't completed its first fetch. Clear bucket/age too, not
          // just strokes/count: leaving the old bucket name and a frozen age
          // standing made the rail read "LIGHTNING 0 · 38m behind" forever
          // through any outage, however long, because rail.js gates the row
          // on `bucket` being truthy. Clearing both is what makes the row
          // disappear, which is the honest state.
          strokes = [];
          count = 0;
          bucket = null;
          age = null;
        } else {
          // Same bucket as last poll. Re-sync age from the collector's own
          // clock on every successful poll, not only when a new bucket
          // arrives: update() stops advancing `age` whenever the layer is
          // invisible or has no strokes (early return), and even while
          // visible a stalled frame loses time forever (main.js clamps dt to
          // 0.1s, so lost wall-clock time is never recovered). Left alone,
          // "how far behind" on the rail would only ever be a lower bound.
          age = state.age;
        }
        refreshVisibility();
      } else if (r.status === 404) {
        // This collector has no lightning layer. It cannot start having one
        // without a redeploy, and a redeploy reloads the page.
        strokes = [];
        count = 0;
        points.visible = false;
        inFlight = false;
        return;
      }
    } catch {
      ok = false;
    }
    inFlight = false;
    if (!stopped) timer = setTimeout(poll, nextLightningPoll(Date.now(), ok, RETRY_MS));
  };

  poll();

  return {
    points,

    /** Put one stroke on the globe, at a real position.
     *
     *  The live feed's own path, exposed so Test Mode can show what lightning
     *  LOOKS like on a night the archive is empty -- which it genuinely can be,
     *  and which is exactly when somebody wants to judge the layer. It does not
     *  touch `strokes` or the poll clock, so a showing cannot make the feed
     *  claim data it never received. */
    spawn,

    /** One frame. `dt` is seconds, the same value arcs.js is driven with. */
    update(dt) {
      clock += dt;
      // See CLOCK_FOLD_SEC above: rebase the whole clock, and every live
      // birth with it, once an hour, so a Float32 `now - birth` never grows
      // into the range where its precision would swallow flashLife. The -1e6
      // sentinels for unused pool slots only get more negative -- harmless,
      // since FRAG's `vAge > glowLife` discard already rejects anything that
      // negative regardless of magnitude.
      if (clock > CLOCK_FOLD_SEC) {
        clock -= CLOCK_FOLD_SEC;
        for (let i = 0; i < births.length; i += 1) births[i] -= CLOCK_FOLD_SEC;
        geometry.attributes.birth.needsUpdate = true;
      }
      uniforms.now.value = clock;
      if (!points.visible || !strokes.length) return;
      const from = playAt;
      playAt += dt;
      if (age !== null) age += dt;
      const due = strokesDue(strokes, from, playAt, cursor);
      cursor = due.cursor;
      for (const s of due.items) spawn(s[1], s[2]);
    },

    setVisible(v) {
      // Never shows a pool with no bucket loaded: the setting says "draw
      // lightning if there is any", and there is not any until a bucket has
      // been fetched. Same reasoning as clouds.js's setVisible.
      points.visible = !!v && strokes.length > 0;
      // Turning the layer on with no bucket held yet must not wait for the
      // ten-minute schedule -- see clouds.js's setVisible for the full
      // reasoning, which is identical here. Only fires when there is nothing
      // to draw (strokes.length === 0); a layer switched back on while its
      // last bucket is still playing needs no fetch at all. Gated on
      // inFlight and MIN_REPOLL_MS so a burst of toggles adds at most one
      // extra request, not one per click.
      const since = lastPollAt ? Date.now() - lastPollAt : Infinity;
      if (shouldPollNow(v, strokes.length > 0, inFlight, since, MIN_REPOLL_MS)) {
        // Deferred one tick, not called synchronously -- see clouds.js's
        // setVisible for why: apply.js's executor runs this handler and only
        // THEN writes CONFIG, so a synchronous poll() would read
        // cfg('layers.lightning') before that write lands and see the OLD
        // value, silently taking the disabled branch instead of fetching.
        if (timer) clearTimeout(timer);
        timer = setTimeout(poll, 0);
      }
    },

    /** Point sprites are sized in pixels, so this is set from the drawing
     *  buffer height on every resize -- a fixed constant is a blob at 4K. */
    setPixelScale(v) {
      uniforms.pixelScale.value = v;
    },

    setUniform(name, value) {
      if (!(name in uniforms)) return;
      if (name === 'color') uniforms.color.value.set(value);
      else uniforms[name].value = value;
    },

    /** What the rail reports: which bucket, how many, how far behind. */
    state() {
      return { bucket, count, age };
    },

    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      geometry.dispose();
      material.dispose();
    },
  };
}
