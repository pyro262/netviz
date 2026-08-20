// The Milky Way band, integrated rather than painted.
//
// Read `docs/notes/renderer-geometry-and-arcs.md` before touching this file.
// galaxy.js holds the model and says what each constant is and where it came
// from; this file is the three.js half: it bakes that model into one all-sky
// texture at boot and then samples it on a sky shell for free, every frame,
// for ever.
//
// WHY A BAKE. The model is a 96-step line-of-sight integral with clumping
// noise at every step -- around a thousand instructions per pixel. That is
// nothing once, and unaffordable at 60 fps on a wall display that runs for
// months. Baked, the runtime cost is one texture fetch. The texture is
// EQUIRECTANGULAR IN GALACTIC COORDINATES, not equatorial: the band then lies
// along the middle row of the map instead of cutting a diagonal across it,
// which is what lets 4096x2048 be enough -- every texel that matters is spent
// on the band. Sampling is a wrap in l and a clamp in b.
//
// The bake is spread over several frames (see BAKE_SLICES). One draw call over
// 8.4M pixels of this shader stalls a weak GPU long enough to be seen as a
// dropped frame at boot, and on some drivers long enough to be seen as a
// hung context.
//
// The texture is 8-bit and stores sqrt(intensity). The band spends most of its
// area below 0.05 of peak, where 8 bits linear is about three distinct values
// and the outskirts terrace into visible steps. sqrt puts the precision where
// the signal is; the shader squares it back.
import * as THREE from 'three';
import { cfg } from './config.js';
import { dayFraction } from './sun.js';
import { GALACTIC_X, GALACTIC_Y, GALACTIC_Z } from './starfield.js';
import {
  MODEL, BRIGHT_CLOUDS, DARK_CLOUDS, SATELLITES, cloudGlsl,
} from './galaxy.js';

// Outside the stars' shell (90) and inside the camera's far plane (100), so
// the band sits behind every star, which is where it is.
const SHELL_RADIUS = 95;
const BAKE_SLICES = 8;

/** Shared by both shaders: the gaussian, wrapped in longitude. */
const GAUSSIAN_GLSL = /* glsl */`
  float g(float l, float b, float cl, float cb, float sl, float sb) {
    float dl = l - cl;
    dl -= 360.0 * floor(dl / 360.0 + 0.5);   // a cloud at l=0.5 reaches l=359
    float x = dl / sl;
    float y = (b - cb) / sb;
    return exp(-0.5 * (x * x + y * y));
  }
`;

const NOISE_GLSL = /* glsl */`
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
`;

/** The model itself. Everything numeric in here comes from galaxy.js's MODEL,
 *  interpolated in, so there is one copy of every constant. */
function bakeFragment(m) {
  const f = (v) => v.toFixed(6);
  return /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform float uDust;       // multiplier on the dust layer's opacity
    uniform float uClump;      // how lumpy the disk is, 0 = perfectly smooth
    uniform float uExposure;   // maps the integral onto 0..1

    ${GAUSSIAN_GLSL}
    ${NOISE_GLSL}
    ${cloudGlsl('brightClouds', BRIGHT_CLOUDS)}
    ${cloudGlsl('darkClouds', DARK_CLOUDS)}
    ${cloudGlsl('satellites', SATELLITES)}

    const float DEG = 0.0174532925199433;
    const vec3 EXT = vec3(${f(m.extR)}, ${f(m.extG)}, ${f(m.extB)});
    // Integrated Galactic starlight is an old, K-dominated population: warm,
    // not white. Dust then reddens it further along any line of sight that
    // has some, which is what makes the centre orange and Auriga white.
    const vec3 POP = vec3(1.0, 0.935, 0.84);

    void main() {
      float l = vUv.x * 360.0;
      float b = (vUv.y - 0.5) * 180.0;
      float cb = cos(b * DEG);
      // Heliocentric galactic cartesian: x to the centre, y to l=90, z to the
      // north galactic pole. The Sun sits 20.8 pc ABOVE the plane, which is
      // why the band is not exactly symmetric about b=0 -- a real, visible
      // asymmetry that costs one constant to have right.
      vec3 dir = vec3(cb * cos(l * DEG), cb * sin(l * DEG), sin(b * DEG));
      vec3 sun = vec3(-${f(m.R0)}, 0.0, ${f(m.Z0)});

      vec3 lum = vec3(0.0);
      vec3 tau = vec3(0.0);
      float prev = 0.0;
      const float K = ${f(m.losBias)};
      float ek = exp(K) - 1.0;
      for (int i = 0; i < ${m.losSteps}; i++) {
        // Logarithmic spacing. Uniform steps coarse enough to reach the far
        // side of the disk step straight over the 75 pc dust layer, and the
        // rift disappears; these are ~10 pc at the Sun and ~1 kpc at 26.
        float t = (float(i) + 1.0) / ${f(m.losSteps)};
        float s1 = ${f(m.losMax)} * (exp(K * t) - 1.0) / ek;
        float ds = s1 - prev;
        float s = 0.5 * (s1 + prev);
        prev = s1;

        vec3 p = sun + dir * s;
        float R = length(p.xy);
        float az = abs(p.z);

        float thin = exp(-R / ${f(m.thinHR)} - az / ${f(m.thinHZ)});
        float thick = ${f(m.thickFrac)} * exp(-R / ${f(m.thickHR)} - az / ${f(m.thickHZ)});
        float rb = length(vec3(p.x, p.y / ${f(m.bulgeYQ)}, p.z / ${f(m.bulgeZQ)}));
        float bulge = ${f(m.bulgeAmp)} * exp(-pow(rb / ${f(m.bulgeScale)}, 1.8));

        // Clumping rides on the disk only. The bulge is 8 kpc away and
        // unresolved; giving it structure invents detail nobody can see.
        //
        // TWO scales, and the near one is weighted UP. An integral 26 kpc
        // long averages structure away: noise at one scale, applied evenly
        // along it, comes out as a smooth glow no matter how strong it is.
        // What a person actually sees as mottling in the band is the nearest
        // kiloparsec or two -- the Local Arm's own clouds -- so the fine
        // octave is faded out with distance rather than applied flat.
        float near = exp(-s / 1.6);
        float clump = 1.0 + uClump * ((fbm(p * 2.7) - 0.5) * 1.15
                                    + (fbm(p * 11.0) - 0.5) * 1.5 * near);
        float emis = (thin + thick) * clump + bulge;

        // The molecular ring, and it is doing most of the work: see MODEL's
        // note. It is what hides the bulge, and hiding the bulge is what
        // leaves the Sagittarius star clouds as the brightest thing in the
        // sky rather than a floodlight at l=0.
        float ring = 1.0 + ${f(m.ringAmp)}
                   * exp(-pow((R - ${f(m.ringR)}) / ${f(m.ringW)}, 2.0));
        float dust = ${f(m.dustTau)} * uDust * ring
                   * exp(-R / ${f(m.dustHR)} - az / ${f(m.dustHZ)})
                   * (0.55 + 0.95 * fbm(p * 4.3));

        lum += emis * exp(-tau) * ds;
        tau += dust * ds * EXT;
      }

      // The direction itself, for everything below that works in PROJECTION
      // rather than along the line of sight.
      vec3 sky = vec3(cb * cos(l * DEG), cb * sin(l * DEG), sin(b * DEG));

      // The named clouds MULTIPLY the integral rather than adding to it, so a
      // star cloud brightens the band where the band is and does nothing off
      // it -- an additive patch floats in empty sky.
      vec3 I = lum * POP * (1.0 + brightClouds(l, b));
      // Scaled by the same uDust as the smooth layer, because they are the
      // same substance: turning the dust down has to take the named clouds
      // with it, or the setting claims to erase the Great Rift and leaves it
      // sitting there.
      I *= exp(-darkClouds(l, b) * uDust * EXT);

      // Fine dust structure. The named clouds are the four a person can point at; between
      // them the real band is shot through with filaments at every scale
      // down to the limit of the eye, and no smooth layer produces those --
      // interstellar dust is fractal, and this is the standard way to say
      // so. Concentrated toward the plane (the same 5 deg the dust layer
      // subtends at a few kpc) and toward the inner Galaxy, where there is
      // simply more of it in front of everything.
      float planeward = exp(-abs(b) / 5.5);
      float inward = 0.55 + 0.45 * cos(l * DEG);
      float filament = fbm(sky * 42.0) + 0.5 * fbm(sky * 130.0);
      I *= exp(-max(0.0, filament - 0.55) * 2.6 * planeward * inward * uDust * EXT);
      // ...and the bright side of the same structure: star clouds too small
      // and too numerous to name.
      I *= 1.0 + uClump * (fbm(sky * 26.0) - 0.5) * 0.9 * planeward;
      // The Magellanic Clouds are not the band and do not get its extinction.
      // Mottled, not smooth: a bare gaussian is a disc, and a disc alone in
      // empty sky reads as a blown pixel rather than as a galaxy.
      float mottle = 0.45 + 1.1 * fbm(sky * 70.0);
      I += satellites(l, b) * mottle * vec3(0.92, 0.95, 1.0) * 0.85;

      I = pow(I * uExposure, vec3(${f(m.displayGamma)}));
      // sqrt-encoded: see the module comment. clamp, not saturate -- the
      // centre genuinely overflows and must clip rather than wrap.
      gl_FragColor = vec4(sqrt(clamp(I, 0.0, 1.0)), 1.0);
    }
  `;
}

const SKY_VERTEX = /* glsl */`
  varying vec3 vDir;
  void main() {
    // Object space, deliberately: the group this mesh hangs in is turned by
    // sidereal time, and the galactic basis is expressed in the untuned frame.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uMap;
  uniform mat3 uGal;          // rows: the galactic x, y and z axes
  uniform float uBrightness;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    vec3 gvec = uGal * d;
    float b = asin(clamp(gvec.z, -1.0, 1.0));
    float l = atan(gvec.y, gvec.x);
    vec2 uv = vec2(fract(l * 0.15915494309), b * 0.31830988618 + 0.5);
    vec3 e = texture2D(uMap, uv).rgb;              // still sqrt-encoded
    // One 8-bit step is visible as a contour across a gradient this smooth
    // and this large, so half a step of noise is added to break it up.
    //
    // The amplitude is ONE TEXTURE STEP AT THIS PIXEL'S OWN VALUE, not a
    // constant, and that is the whole point. The map stores sqrt(I), so the
    // decoded step at e is d(e*e)/de/255 = 2e/255 -- which goes to zero in
    // empty sky and is largest where the band is bright. A constant
    // amplitude was shipped first and read as GRAIN OVER THE WHOLE DISPLAY:
    // 0.0035 linear is nothing against the band, but sRGB lifts half of it
    // to about 11/255 against a sky that is nearly black, and it does not
    // fall away when the brightness setting does. Empty sky has nothing to
    // dither and must be left alone.
    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vec3 c = e * e + (dither - 0.5) * (2.0 * e / 255.0);
    gl_FragColor = vec4(max(c, 0.0) * uBrightness, 1.0);
  }
`;

/**
 * @param renderer  needed for the bake, and only for the bake.
 */
export function createMilkyWay(renderer) {
  const group = new THREE.Group();

  // 4096x2048 is 5.3 arcmin per texel, finer than the eye resolves at any
  // sane viewing distance, and 33 MB of VRAM. Clamped to what the driver
  // admits to: a 2048 cap is a 2015 phone, not a wall, but a texture larger
  // than maxTextureSize fails silently black on some drivers.
  const want = cfg('appearance.milkyway.resolution', 4096);
  const width = Math.min(want, renderer.capabilities.maxTextureSize);
  const height = width / 2;

  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,        // l wraps at the l=0 seam
    wrapT: THREE.ClampToEdgeWrapping,   // b does not: it ends at the poles
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace,     // this is data, not a picture
  });

  const bakeMat = new THREE.ShaderMaterial({
    uniforms: {
      uDust: { value: cfg('appearance.milkyway.dust', 1.0) },
      uClump: { value: cfg('appearance.milkyway.clumping', 1.0) },
      uExposure: { value: cfg('appearance.milkyway.exposure', 0.5) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: bakeFragment(MODEL),
    depthTest: false,
    depthWrite: false,
  });
  const bakeScene = new THREE.Scene();
  const bakeCam = new THREE.Camera();
  bakeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat));

  let pending = 0;          // slices still to draw; 0 means the map is current

  /** Draw one horizontal slice of the map. Scissored, so the cost really is
   *  one slice's worth of fragments and not a full pass eight times. */
  function bakeSlice() {
    const i = BAKE_SLICES - pending;
    const y = Math.floor((i * height) / BAKE_SLICES);
    const h = Math.floor(((i + 1) * height) / BAKE_SLICES) - y;
    const prevTarget = renderer.getRenderTarget();
    const prevScissor = renderer.getScissorTest();
    renderer.setRenderTarget(target);
    renderer.setScissorTest(true);
    renderer.setScissor(0, y, width, h);
    renderer.render(bakeScene, bakeCam);
    renderer.setScissorTest(prevScissor);
    renderer.setRenderTarget(prevTarget);
    pending -= 1;
  }

  function rebake() { pending = BAKE_SLICES; }
  rebake();

  const gal = new THREE.Matrix3().set(
    GALACTIC_X[0], GALACTIC_X[1], GALACTIC_X[2],
    GALACTIC_Y[0], GALACTIC_Y[1], GALACTIC_Y[2],
    GALACTIC_Z[0], GALACTIC_Z[1], GALACTIC_Z[2],
  );

  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: target.texture },
      uGal: { value: gal },
      uBrightness: { value: cfg('appearance.milkyway.brightness', 1.0) },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    // depthTest STAYS ON, and this is not a detail. An additive material is
    // `transparent`, and three draws the whole transparent list AFTER the
    // opaque one whatever renderOrder says -- so a sky shell with depthTest
    // off paints over the globe that was drawn before it, and every pixel of
    // the planet is lifted by whatever the sky behind it happens to be. The
    // shell is at radius 95 and the globe is at 1: the depth buffer the
    // opaque surface already wrote is exactly the thing that knows the band
    // is behind it. depthWrite stays OFF, because the band must not occlude
    // the stars or the arcs.
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,   // it adds light to the sky, like light
    transparent: true,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL_RADIUS, 64, 32), skyMat);
  // First of the transparent draws, so the stars and the arcs blend on top of
  // a sky that already has the band in it. It neither occludes nor
  // bloom-glows: without hideInBloom the bloom pass swaps in a black stand-in
  // the size of the sky and the whole frame goes dark -- the same trap the
  // stars hit, arrived at from the other side.
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.userData.hideInBloom = true;
  group.add(mesh);
  group.visible = cfg('layers.milkyway', true);

  let base = cfg('appearance.milkyway.brightness', 1.0);
  // The band ramps with daylight for exactly the reason the stars do: a lit
  // room washes it out. It reads the STARS' two settings on purpose -- the sky
  // brightening by two different curves at dawn is a thing nobody asked for.
  let dayGain = cfg('appearance.starDayGain', 1.0);
  let rampMinutes = cfg('appearance.starRampMinutes', 30);

  function applyBrightness(date) {
    const home = cfg('home', null);
    if (!home || dayGain === 1) {
      skyMat.uniforms.uBrightness.value = base;
      return;
    }
    const f = dayFraction(date, home.lat, home.lon, rampMinutes);
    skyMat.uniforms.uBrightness.value = base * (1 + (dayGain - 1) * f);
  }
  applyBrightness(new Date());

  let sinceRamp = 0;
  const readPixel = new Uint8Array(4);
  return {
    group,
    mesh,
    width,
    height,
    /** Frames still needed before the map is complete. Verification support:
     *  a tool that samples the texture has to know when it is finished. */
    baking() { return pending; },
    brightness() { return skyMat.uniforms.uBrightness.value; },
    applyBrightness,
    setVisible(on) { group.visible = !!on; },
    setBrightness(v) { base = v; applyBrightness(new Date()); },
    setDayGain(v) { dayGain = v; applyBrightness(new Date()); },
    setRampMinutes(v) { rampMinutes = v; applyBrightness(new Date()); },
    // Each of these changes the MODEL, so each re-bakes. Cheap enough to do
    // from a slider: eight frames, and the old map stays on screen until the
    // slice that replaces it lands.
    setDust(v) { bakeMat.uniforms.uDust.value = v; rebake(); },
    setClumping(v) { bakeMat.uniforms.uClump.value = v; rebake(); },
    setExposure(v) { bakeMat.uniforms.uExposure.value = v; rebake(); },
    /**
     * Intensity of the baked map at a galactic coordinate, decoded back out of
     * the sqrt encoding. This is what makes "the band is in the right place"
     * checkable with a number instead of an opinion -- see
     * tools/verify_milkyway.py.
     */
    sample(lDeg, bDeg) {
      const u = ((lDeg % 360) + 360) % 360 / 360;
      const v = (bDeg + 90) / 180;
      const x = Math.min(width - 1, Math.max(0, Math.round(u * width)));
      const y = Math.min(height - 1, Math.max(0, Math.round(v * height)));
      renderer.readRenderTargetPixels(target, x, y, 1, 1, readPixel);
      return [0, 1, 2].map((i) => (readPixel[i] / 255) ** 2);
    },
    update(dt) {
      if (pending > 0) bakeSlice();
      // The ramp moves by 0.3% in 5 seconds; anything finer is wasted
      // trigonometry. Same tick the stars use, for the same reason.
      sinceRamp += dt;
      if (sinceRamp < 5) return;
      sinceRamp = 0;
      applyBrightness(new Date());
    },
    dispose() {
      target.dispose();
      skyMat.dispose();
      bakeMat.dispose();
      mesh.geometry.dispose();
    },
  };
}
