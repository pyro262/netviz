// Aurora, sized by the live planetary K-index.
//
// The oval is drawn around the GEOMAGNETIC poles, not the geographic ones --
// that offset is why Canada sees aurora at latitudes where Siberia does not,
// and getting it wrong is the single most visible way to draw a fake aurora.
// Its equatorward edge follows Kp, which the collector polls from NOAA SWPC
// and serves at /aurora.json. No Kp, no aurora: an aurora that is always there
// says nothing.
import * as THREE from 'three';
import { nextPollDelay, auroraFromReading } from './schedule.js';

// IGRF-13 geomagnetic north pole for epoch 2025: 80.7N, 72.7W. The south
// magnetic pole is not antipodal in reality, but the dipole axis is what sets
// the oval, so the southern oval is drawn about the antipode of this.
const GEOMAG_POLE_LAT = 80.7;
const GEOMAG_POLE_LON = -72.7;

// NOAA publishes planetary Kp on 3-hour boundaries and the collector polls once
// per publication, so the kiosk matches that cadence -- six minutes past each
// boundary, two minutes behind the collector's own fetch. Polling faster than
// the source publishes is load, not freshness.
const PERIOD_MS = 3 * 3600_000;
const OFFSET_MS = 6 * 60_000;
// Except when something is wrong: waiting three hours to notice the collector
// came back would leave the wall wrong for the whole period.
const RETRY_MS = 600_000;

/** Same convention as globe.js latLonToVec3: theta = -lon. */
function poleVector(lat, lon) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((-lon) * Math.PI) / 180;
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  );
}

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3 pole;
  uniform vec3 sunDir;
  uniform float boundary;   // cos of the colatitude of the equatorward edge
  uniform float strength;   // 0 when quiet, 1 in a strong storm
  uniform float time;
  uniform vec3 lowColor;
  uniform vec3 highColor;
  varying vec3 vDir;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 n = normalize(vDir);
    float md = dot(n, normalize(pole));        // 1 at the magnetic pole
    float south = dot(n, -normalize(pole));
    float m = max(md, south);                  // both ovals, same rule

    // A band, not a cap: the oval is a ring with a hole over the pole itself.
    float outer = boundary;                    // equatorward edge
    float inner = mix(boundary, 1.0, 0.62);    // poleward edge
    float band = smoothstep(outer, outer + 0.06, m) * (1.0 - smoothstep(inner, inner + 0.10, m));
    if (band <= 0.001) discard;

    // Curtains: stretched noise drifting slowly around the oval.
    float c = noise(vec3(n.xz * 9.0, time * 0.05)) * 0.6
            + noise(vec3(n.xz * 23.0, time * 0.11)) * 0.4;
    c = smoothstep(0.35, 0.95, c);

    // Daylight drowns it, exactly as it does in life.
    float night = 1.0 - smoothstep(-0.25, 0.10, dot(n, normalize(sunDir)));

    float a = band * c * night * strength;
    if (a < 0.004) discard;
    // Green at the base, violet-red at the top of the band -- oxygen at 100 km
    // and 200+ km respectively, which is the real colour split.
    vec3 col = mix(lowColor, highColor, smoothstep(outer, inner, m));
    gl_FragColor = vec4(col, a * 0.55);
  }
`;

export function createAurora(radius) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      pole: { value: poleVector(GEOMAG_POLE_LAT, GEOMAG_POLE_LON) },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      boundary: { value: Math.cos(((90 - 66.5) * Math.PI) / 180) },
      strength: { value: 0 },        // nothing until NOAA says otherwise
      time: { value: 0 },
      lowColor: { value: new THREE.Color('#38ffa8') },   // 557.7 nm oxygen green
      highColor: { value: new THREE.Color('#c56cff') },   // 630 nm red, over violet
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  // Aurora sits at ~100-300 km, which is 1.016-1.047 Earth radii. Drawn at
  // 1.03: above the city lights, below the atmosphere shell at 1.045.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.03, 96, 64), material);
  mesh.frustumCulled = false;
  mesh.layers.enable(1);             // it glows
  mesh.userData.bloomScale = 0.5;

  let kp = null;
  let stale = true;

  async function poll() {
    let healthy = true;
    try {
      const r = await fetch('/aurora.json', { cache: 'no-store' });
      if (!r.ok) {                       // 404: this build has no endpoint
        mesh.visible = false;
        healthy = false;
      } else {
        const body = await r.json();
        kp = body.kp;
        stale = body.stale;
        healthy = kp !== null && kp !== undefined && !stale;
        apply();
      }
    } catch {
      stale = true;      // keep the last oval; the collector may be restarting
      healthy = false;
      apply();
    }
    setTimeout(poll, nextPollDelay(Date.now(), PERIOD_MS, OFFSET_MS, healthy, RETRY_MS));
  }

  // The `layers.aurora` setting, held rather than read once at construction.
  // apply() runs again on EVERY poll, so a layer toggle that only wrote the
  // mesh would be undone by the next reading -- up to three hours later, or ten
  // minutes on an unhealthy poll -- while CONFIG still said the layer was off.
  let enabled = true;

  function apply() {
    const want = auroraFromReading({ enabled, kp, stale });
    mesh.visible = want.visible;
    if (!want.visible) return;
    material.uniforms.boundary.value =
      Math.cos(((90 - want.edgeLat) * Math.PI) / 180);
    material.uniforms.strength.value = want.strength;
  }

  poll();   // once now, then on the source's own cadence

  return {
    mesh,
    /** The `layers.aurora` toggle. Goes through here rather than through
     *  mesh.visible directly, or the next poll would put the oval back. */
    setVisible(on) { enabled = !!on; apply(); },
    visible: () => mesh.visible,
    update(dt, sunLocal) {
      material.uniforms.time.value += dt;
      material.uniforms.sunDir.value.copy(sunLocal);
    },
    debug: () => ({ kp, stale, strength: material.uniforms.strength.value }),
  };
}
