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
import { nextLightningPoll, strokesDue } from './schedule.js';

// 11.5 strokes/second worldwide (measured) times a ~3.2s total life is about 37
// alive at once. 2048 is fifty times that: the pool exists so nothing allocates
// per stroke on a display that runs for months, not because the bound is tight.
const POOL = 2048;

const RETRY_MS = 120_000;

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
    let ok = false;
    try {
      const r = await fetch('/lightning.json', { cache: 'no-store' });
      if (r.ok) {
        const state = await r.json();
        ok = true;
        if (state.bucket && state.bucket !== bucket) {
          bucket = state.bucket;
          strokes = Array.isArray(state.strokes) ? state.strokes : [];
          count = strokes.length;
          // Playback starts where the bucket already is, not at 0: the poll may
          // land a minute late, and starting at 0 every time would replay that
          // minute and then run past the next bucket's arrival.
          playAt = Math.max(0, Math.min(state.window || 600, state.age - (32 * 60)));
          cursor = 0;
          age = state.age;
        } else if (!state.bucket) {
          // The collector is up and has nothing yet. Keep asking.
          strokes = [];
          count = 0;
        }
        refreshVisibility();
      } else if (r.status === 404) {
        // This collector has no lightning layer. It cannot start having one
        // without a redeploy, and a redeploy reloads the page.
        strokes = [];
        count = 0;
        points.visible = false;
        return;
      }
    } catch {
      ok = false;
    }
    if (!stopped) timer = setTimeout(poll, nextLightningPoll(Date.now(), ok, RETRY_MS));
  };

  poll();

  return {
    points,

    /** One frame. `dt` is seconds, the same value arcs.js is driven with. */
    update(dt) {
      clock += dt;
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
