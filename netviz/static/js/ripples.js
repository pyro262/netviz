// Expanding rings on the globe surface where an arc lands.
//
// Arcs used to simply stop at home, which read as "the line ended" rather than
// "something arrived". A ripple gives the landing a moment, and because the
// block ring is larger and slower than a flow ring, severity is legible with no
// legend on the wall.
//
// Same discipline as arcs.js: fixed pool, geometry allocated once, nothing
// allocated per event on a display that runs for months.
import * as THREE from 'three';
import { cfg } from './config.js';
import { plasmaAt } from './palette.js';
import { latLonToVec3 } from './globe.js';
import { createCooldown } from './cooldown.js';

// maxRadius is in globe radii. A flow ripple stays small enough that a dozen
// overlapping ones do not merge into a disc; the block ripple is allowed to be
// obvious, because that is the one worth walking over for.
export const RIPPLE = {
  flow:  { life: 1.1, maxRadius: 0.055, width: 0.30, color: plasmaAt(0.34), bloomScale: 1.1 },
  highlight: { life: 1.1, maxRadius: 0.055, width: 0.30,
           color: new THREE.Color('#22d3ee').multiplyScalar(0.51), bloomScale: 0.41 },
  block: { life: 2.4, maxRadius: 0.150, width: 0.22,
           color: plasmaAt(0.86).multiplyScalar(0.74), bloomScale: 0.5 },
};

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A ring drawn in the fragment shader on a quad, rather than RingGeometry:
// the ring's thickness then stays constant while it expands, and one geometry
// serves every size.
const FRAG = /* glsl */`
  uniform vec3 color;
  uniform float progress;   // 0..1 across the ripple's life
  uniform float width;      // ring thickness as a fraction of the radius
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;          // 0 at centre, 1 at quad edge
    float edge = progress;
    float band = 1.0 - smoothstep(0.0, width, abs(d - edge));
    float fade = 1.0 - progress;                 // thins out as it grows
    gl_FragColor = vec4(color, band * fade * 0.85);
    if (gl_FragColor.a < 0.002) discard;
  }
`;

// One ripple per target per two minutes. Nearly every inbound arc lands on the
// same point -- home -- so ripple-per-arrival was a permanent pulse there rather
// than an event worth looking at.
const COOLDOWN_SECONDS = cfg('ripples.cooldownSeconds', 120);

export function createRipples(radius, capacity = 48) {
  const group = new THREE.Group();
  const pool = [];
  const quad = new THREE.PlaneGeometry(1, 1);

  for (let i = 0; i < capacity; i += 1) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        color: { value: new THREE.Color(0xffffff) },
        progress: { value: 0 },
        width: { value: 0.3 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    const mesh = new THREE.Mesh(quad, mat);
    mesh.layers.enable(1);        // bloom layer; post.js owns the constant
    mesh.visible = false;
    group.add(mesh);
    pool.push({ mesh, mat, age: 0, spec: null, active: false });
  }

  let cursor = 0;
  let last = null;                  // diagnostics only; see lastColor()
  const cooldown = createCooldown(COOLDOWN_SECONDS);

  function take() {
    for (let i = 0; i < capacity; i += 1) {
      const slot = pool[(cursor + i) % capacity];
      if (!slot.active) {
        cursor = (cursor + i + 1) % capacity;
        return slot;
      }
    }
    let oldest = pool[0];
    for (const s of pool) if (s.age > oldest.age) oldest = s;
    return oldest;
  }

  /**
   * @param className one of RIPPLE's keys; anything else is treated as flow.
   * @param color    optional THREE.Color -- the landing arc's own color.
   *                  Copied, never retained: the caller passes a live uniform,
   *                  which the arc pool rewrites when it recycles the slot.
   * @param bloomScale optional number, same source.
   *
   * Size and life stay keyed by CLASS, not by the arc: a block ring is larger
   * and slower than a flow ring, which is how severity reads without a legend.
   * Only the color follows the arc. RIPPLE's own colors stay as the fallback
   * -- a colorless call must draw something sane rather than black.
   */
  function spawn(lat, lon, className, color = null, bloomScale = null) {
    const spec = RIPPLE[className] || RIPPLE.flow;
    if (!cooldown.allow(lat, lon, className, performance.now() / 1000)) return;
    const slot = take();

    // Sit the quad flat on the surface, facing outward, just above the
    // coastlines so it is never swallowed by the sphere at a grazing angle.
    const p = latLonToVec3(lat, lon, radius * 1.004);
    slot.mesh.position.copy(p);
    slot.mesh.lookAt(p.clone().multiplyScalar(2));
    // The quad must be twice the ripple's radius, since the ring reaches the
    // quad edge at progress = 1.
    const size = radius * spec.maxRadius * 2;
    slot.mesh.scale.set(size, size, 1);

    slot.mat.uniforms.color.value.copy(color || spec.color);
    slot.mat.uniforms.width.value = spec.width;
    slot.mat.uniforms.progress.value = 0;
    slot.mesh.userData.bloomScale = bloomScale === null || bloomScale === undefined
      ? spec.bloomScale : bloomScale;
    slot.age = 0;
    slot.spec = spec;
    slot.active = true;
    slot.mesh.visible = true;
    slot.lat = lat;                 // diagnostics only; see lastRipple()
    slot.lon = lon;
    slot.cls = className;
    last = slot;
  }

  function update(dt) {
    for (const slot of pool) {
      if (!slot.active) continue;
      slot.age += dt;
      const t = slot.age / slot.spec.life;
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        continue;
      }
      // Ease out: fast at the moment of impact, slowing as it spreads.
      slot.mat.uniforms.progress.value = 1 - (1 - t) * (1 - t);
    }
  }

  function liveCount() {
    return pool.reduce((n, s) => n + (s.active ? 1 : 0), 0);
  }

  return {
    group, spawn, update, liveCount,
    setCooldown(v) { cooldown.setSeconds(v); },
    /** Diagnostics only -- tools/verify_walk.py reads the color the most
     *  recent ring was actually drawn in, and WHERE, because the live feed
     *  spawns rings of its own throughout and a color alone cannot say
     *  which arc drew it. Nothing on the wall reads this. */
    lastRipple() {
      return last
        ? { color: last.mat.uniforms.color.value.getHex(),
            lat: last.lat, lon: last.lon, cls: last.cls }
        : null;
    },
  };
}
