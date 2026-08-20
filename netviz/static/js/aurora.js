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
import {
  GEOMAG_POLE_LAT, GEOMAG_POLE_LON, R_INNER, R_OUTER, OVAL_WIDTH,
  MIDNIGHT_OFFSET, PEAK_MLT, DAY_FLOOR,
} from './auroral_oval.js';

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

/** A JS number as a GLSL FLOAT literal.
 *
 *  `4.0` in JavaScript interpolates as the string "4", which GLSL reads as an
 *  int -- and `4 * someFloat` is a compile error, not a coercion. Caught the
 *  first time this shader was handed to a real browser, which is the only place
 *  GLSL is ever compiled. */
const glslFloat = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));

const VERT = /* glsl */`
  // The LOCAL position, not a normalized direction: the raymarch needs a point
  // on the shell to aim a ray at, and the pole, the sun and the eye are all
  // given in this same local space -- the mesh rides globe.group, which rotates.
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The volume, marched.
//
// WHAT THE OLD SHADER GOT WRONG, all three of it on one shell:
//
//   * ONE SHELL AT 1.03. An aurora seen from orbit is a CURTAIN standing off
//     the disc, and a shell has no height to show at the limb -- which is the
//     half of the view a globe display spends most of its time looking at.
//   * THE CURTAIN NOISE WAS SAMPLED ON A PLANAR PROJECTION of the surface
//     normal -- its two horizontal components, scaled. Those COLLAPSE at the
//     poles: both go to zero exactly where the oval is drawn, so the curtains
//     smeared into a wash at the one latitude they exist at. (Written out in
//     words rather than in code, because a test greps this file for that
//     construction and prose documenting a fix must not contain the thing
//     being fixed.)
//   * The green/red split ran across LATITUDE. It is a height split -- 557.7 nm
//     oxygen at ~100 km, 630 nm at 200+ km -- so painting it across the band
//     put red on the poleward edge of a flat ring and had nothing to show
//     standing up.
//
// The arithmetic here is auroral_oval.js's, re-implemented in GLSL because
// GLSL cannot import. THE TWO COPIES MUST MOVE TOGETHER; the constants are
// interpolated from that module's exports so at least the numbers cannot
// drift, and tests/js/aurora.test.mjs asserts the interpolation is still there.
// NO BACKTICKS BELOW THIS LINE, in code or in comments. The whole shader is one
// template literal, so a backtick inside a GLSL comment ENDS it -- the file then
// parses as JavaScript right up to the point where the shader stopped being a
// string, and the error surfaces dozens of lines later on an unrelated
// identifier. This has now cost two debugging rounds; write 'x' or X, not `x`.
const FRAG = /* glsl */`
  uniform vec3 pole;        // dipole axis, local space
  uniform vec3 sunDir;      // toward the sun, local space
  uniform vec3 camLocal;    // the eye, local space -- the ray origin
  uniform float edgeCos;    // cos(colatitude) of the NOON equatorward edge
  uniform float strength;   // 0 when quiet, 1 in a strong storm
  uniform float time;
  uniform vec3 lowColor;
  uniform vec3 highColor;
  varying vec3 vLocal;

  const float R_PLANET = 1.0;
  const float R_INNER  = ${glslFloat(R_INNER)};
  const float R_OUTER  = ${glslFloat(R_OUTER)};
  const float TAU = 6.2831853;
  const int STEPS = 14;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  /** Both roots of |ro + t*rd| = R, or hit=false. Mirrors raySphere(). */
  bool sphereRoots(vec3 ro, vec3 rd, float R, out float t0, out float t1) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float disc = b * b - c;
    if (disc <= 0.0) return false;
    float s = sqrt(disc);
    t0 = -b - s; t1 = -b + s;
    return true;
  }

  void main() {
    vec3 ro = camLocal;
    vec3 rd = normalize(vLocal - camLocal);

    // marchSpan(), in GLSL. THE PLANET IS CLIPPED ARITHMETICALLY, not by the
    // depth buffer: a back-face additive shell with depthTest ON loses every
    // near-side fragment to the globe's own depth, and with it OFF it paints
    // the far-side oval straight through the Earth. Clipping the ray is also
    // strictly better than either, because a column crossing the limb gets
    // PARTIALLY occluded -- which is what actually happens.
    float o0, o1;
    if (!sphereRoots(ro, rd, R_OUTER, o0, o1)) discard;
    float tStart = max(o0, 0.0);
    float tEnd = o1;
    float p0, p1;
    if (sphereRoots(ro, rd, R_PLANET, p0, p1) && p0 > tStart) tEnd = min(tEnd, p0);
    if (tEnd <= tStart) discard;

    vec3 m0 = normalize(pole);
    vec3 sun = normalize(sunDir);
    float stepLen = (tEnd - tStart) / float(STEPS);
    // Jittered, per pixel. Fourteen steps band visibly without it, and a
    // CONSTANT-amplitude dither is what CLAUDE.md records as invisible in a
    // headless A/B and plainly wrong on the wall -- this one is per-pixel
    // noise, and it is on the wall-check list for exactly that reason.
    float jitter = hash(vec3(gl_FragCoord.xy, 1.0));
    vec3 acc = vec3(0.0);

    for (int i = 0; i < STEPS; i++) {
      float t = tStart + (float(i) + jitter) * stepLen;
      vec3 p = ro + rd * t;
      float r = length(p);
      float alt = (r - R_INNER) / (R_OUTER - R_INNER);
      if (alt < 0.0 || alt > 1.0) continue;
      vec3 n = p / r;

      // magneticFrame(), in GLSL. Both hemispheres run the same arithmetic
      // against their own end of the dipole.
      float hemi = dot(n, m0) >= 0.0 ? 1.0 : -1.0;
      vec3 m = m0 * hemi;
      float cosCol = dot(n, m);
      vec3 mid = -sun + m * dot(sun, m);
      float midLen = length(mid);
      // Near a solstice the sun sits close to the axis and that projection goes
      // short and noisy; fall back to any vector perpendicular to the axis
      // rather than normalizing something near zero.
      mid = midLen < 1e-4
        ? normalize(cross(m, abs(m.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)))
        : mid / midLen;
      vec3 east = normalize(cross(m, mid));
      float phi = atan(dot(n, east), dot(n, mid));   // 0 at magnetic midnight
      float w = cos(phi);                            // +1 midnight, -1 noon

      // ovalEdge() and ovalThickness(), in cosine so no acos runs in the loop.
      // The edge moves equatorward toward midnight, which is LOWER latitude and
      // therefore a SMALLER cos-of-colatitude... no: colatitude grows, so its
      // cosine shrinks. Shift edgeCos down by the midnight term's cosine cost.
      float edgeLatShift = ${glslFloat(MIDNIGHT_OFFSET)} * ((w + 1.0) / 2.0);
      float widthDeg = ${glslFloat(OVAL_WIDTH)} * (1.0 + 0.3 * (1.0 + w));
      float colDeg = degrees(acos(clamp(cosCol, -1.0, 1.0)));
      float edgeDeg = degrees(acos(clamp(edgeCos, -1.0, 1.0))) + edgeLatShift;
      // u: 0 at the equatorward edge, 1 at the poleward edge.
      float u = (edgeDeg - colDeg) / widthDeg;
      float band = smoothstep(0.0, 0.18, u) * (1.0 - smoothstep(0.82, 1.0, u));
      if (band <= 0.001) continue;

      // Rays, arcs and the pulse, all in (phi, u). The HIGH frequency is on
      // phi and the LOW one on u, which is what makes the structure run
      // poleward-equatorward rather than mottling.
      float f = fbm(vec3(phi * 38.0, u * 2.2, time * 0.06));
      // Real aurora is one to three narrow bright arcs inside a diffuse glow,
      // not one smooth smear -- which is what the old single smoothstep drew.
      float arc = pow(0.5 + 0.5 * cos((u * 3.0 + f * 0.35) * TAU), 6.0);
      float shape = 0.35 + 0.65 * arc;
      // A slow substorm-like brightening drifting around the oval.
      float pulse = 0.75 + 0.25 * sin(phi * 2.0 - time * 0.13);

      // ovalBrightness(), in GLSL. THE RING WAS ALWAYS THE RIGHT SHAPE -- the
      // real thing is called the auroral oval because it is one -- but it was
      // drawn EVENLY around that ring, which reads as a drawn circle rather
      // than as aurora. Intensity is strongly weighted to the
      // midnight-through-dawn sector, where substorms break up; the dayside is
      // faint by comparison and keeps only a floor, because the cusp aurora is
      // real and continuous with the rest of the ring. Daylight finishes it
      // off, and that is the separate night gate below.
      //
      // phi is radians from magnetic midnight, so the peak's offset in HOURS
      // becomes an angle at 15 degrees an hour.
      float peak = cos(phi - ${glslFloat(PEAK_MLT)} * (TAU / 24.0));
      float mltGain = ${glslFloat(DAY_FLOOR)}
                    + (1.0 - ${glslFloat(DAY_FLOOR)}) * pow(max(0.0, (peak + 1.0) * 0.5), 1.6);

      // Daylight drowns it, exactly as it does in life.
      float night = 1.0 - smoothstep(-0.25, 0.10, dot(n, sun));
      // Falls with height, so the base is bright and the tops are thin -- which
      // is what makes a curtain read as standing up rather than as a slab.
      float density = exp(-alt * 2.6) * band * shape * pulse * mltGain * night * f;
      acc += mix(lowColor, highColor, smoothstep(0.12, 0.7, alt)) * density * stepLen;
    }

    if (dot(acc, acc) < 1e-8) discard;
    // AdditiveBlending takes the color and ignores the alpha, so the fade lives
    // in 'acc' and the alpha is a constant.
    gl_FragColor = vec4(acc * strength * 26.0, 1.0);
  }
`;

export function createAurora(radius) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      pole: { value: poleVector(GEOMAG_POLE_LAT, GEOMAG_POLE_LON) },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      // The eye, in the same local space the pole and the sun are given in.
      // Seeded off the globe so a frame drawn before the first update() has a
      // ray origin outside the shell rather than one at the planet's center.
      camLocal: { value: new THREE.Vector3(0, 0, 6) },
      edgeCos: { value: Math.cos(((90 - 66.5) * Math.PI) / 180) },
      strength: { value: 0 },        // nothing until NOAA says otherwise
      time: { value: 0 },
      lowColor: { value: new THREE.Color('#38ffa8') },   // 557.7 nm oxygen green
      highColor: { value: new THREE.Color('#c56cff') },   // 630 nm red, over violet
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // The planet is clipped IN THE SHADER instead -- see the marchSpan comment
    // in auroral_oval.js for why neither depth setting can be right for a
    // back-face additive volume.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    // BackSide: the shell is a device for generating rays, and the ray has to
    // start at the eye and pass THROUGH the volume. A front-face shell hands
    // the fragment shader the near surface and nothing to march.
    side: THREE.BackSide,
  });
  // The shell reaches the top of the span the shader marches. Tessellation is
  // down from 96x64 because every visible detail is per-fragment now; the
  // sphere only has to be round enough to generate rays.
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * R_OUTER, 64, 48), material);
  mesh.frustumCulled = false;
  mesh.layers.enable(1);             // it glows
  mesh.userData.bloomScale = 0.5;

  let kp = null;
  let stale = true;

  // Held so apply() -- which re-asserts every poll -- can read the current
  // choice back rather than a color setter's write being reverted on the
  // next poll. apply() below never touches the color uniforms itself, so
  // there is nothing to revert today, but the state lives here rather than
  // as a write-only uniform so that stays true if apply() ever needs them.
  const state = {
    lowColor: material.uniforms.lowColor.value.clone(),
    highColor: material.uniforms.highColor.value.clone(),
  };

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
    // The NOON baseline. The shader applies the local-time term itself, from
    // ovalEdge()'s own (w+1)/2 shape -- so this stays exactly the number
    // schedule.auroraFromReading and the collector both compute.
    material.uniforms.edgeCos.value =
      Math.cos(((90 - want.edgeLat) * Math.PI) / 180);
    material.uniforms.strength.value = want.strength;
  }

  poll();   // once now, then on the source's own cadence

  return {
    mesh,
    /** Told, not overwritten. aurora.apply() recomputes its own uniforms on
     *  every Kp poll, so writing the uniform directly is reverted within three
     *  hours -- the exact failure layers.aurora already had. These are held as
     *  fields that apply() reads. */
    setColors(low, high) {
      state.lowColor = low.clone();
      state.highColor = high.clone();
      material.uniforms.lowColor.value.copy(state.lowColor);
      material.uniforms.highColor.value.copy(state.highColor);
    },
    /** The `layers.aurora` toggle. Goes through here rather than through
     *  mesh.visible directly, or the next poll would put the oval back. */
    setVisible(on) { enabled = !!on; apply(); },
    visible: () => mesh.visible,
    /** `camLocal` is the ray origin and is optional only so the two existing
     *  call sites cannot break: main.js calls this once at boot with the sun
     *  alone and once per frame in the render loop. A frame drawn without it
     *  keeps the last origin, which is the previous frame's -- wrong by one
     *  frame of camera motion, never wrong by a whole planet. */
    update(dt, sunLocal, camLocal) {
      material.uniforms.time.value += dt;
      material.uniforms.sunDir.value.copy(sunLocal);
      if (camLocal) material.uniforms.camLocal.value.copy(camLocal);
    },
    /** TEST HOOK, named so nobody mistakes it for product.
     *
     *  tools/verify_aurora.py needs a storm on demand; the wall gets whatever
     *  NOAA says. It routes through the same apply() a real poll does, so it
     *  cannot drift from the real path, and the next poll overwrites it. */
    __setReading({ kp: k, stale: st } = {}) {
      kp = k;
      stale = !!st;
      apply();
      return { kp, stale, strength: material.uniforms.strength.value };
    },
    debug: () => ({ kp, stale, strength: material.uniforms.strength.value }),
  };
}
