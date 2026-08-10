// The real sky and nothing else: HYG catalogue to magnitude 6.5, placed by
// right ascension and declination, coloured by B-V index, turned by Greenwich
// sidereal time.
//
// The painted Milky Way band and its 7,000 synthetic haze stars were removed
// 2026-08-09 at the user's request -- every point here is now a real catalogue
// star. The band's own crowding still shows, because the catalogue is genuinely
// denser along the galactic plane.
//
// This replaced three shells of uniform random points. Random stars are the one
// sky nobody has ever seen -- no constellations, no Milky Way, and no relation
// to the terminator crossing the globe in the same frame. These are the actual
// stars in the actual orientation for the current moment, so Orion is Orion.
import * as THREE from 'three';
import {
  gmstDegrees, equatorialToVec, bvToRgb, magnitudeToSize, magnitudeToAlpha,
} from './starfield.js';

const SHELL_RADIUS = 90;      // inside the camera's far plane of 100

async function loadCatalogue(radius) {
  const buf = await (await fetch('/data/stars.bin')).arrayBuffer();
  const f = new Float32Array(buf);              // [raDeg, dec, mag, ci] per star
  const count = f.length / 4;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    // Built at sidereal time zero; the group is then turned to the moment.
    const v = equatorialToVec(f[i * 4], f[i * 4 + 1]);
    pos[i * 3] = v[0] * radius;
    pos[i * 3 + 1] = v[1] * radius;
    pos[i * 3 + 2] = v[2] * radius;

    const rgb = bvToRgb(f[i * 4 + 3]);
    col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2];
    size[i] = magnitudeToSize(f[i * 4 + 2]);
    alpha[i] = magnitudeToAlpha(f[i * 4 + 2]);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  geom.setAttribute('palpha', new THREE.BufferAttribute(alpha, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { pixelScale: { value: 1.0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    vertexShader: /* glsl */`
      attribute float psize;
      attribute float palpha;
      uniform float pixelScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = palpha;
        // Sized in pixels, so the scale follows the drawing buffer -- same
        // reason as the city sprites, where a fixed constant that looked right
        // at 1440p turned into blobs at 4K.
        gl_PointSize = psize * pixelScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        // Soft core rather than a flat disc, so a bright star reads as a point
        // of light instead of a filled circle.
        float a = pow(max(0.0, 1.0 - r * 2.0), 1.6) * vAlpha;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  // Stars neither bloom nor occlude. Without this the bloom pass swaps in a
  // black PointsMaterial stand-in whose `size` is in WORLD units -- 9000 black
  // squares punched across the sky. This is the same trap the module comment in
  // post.js describes; a ShaderMaterial-based point cloud walks straight into
  // it because it has no `size` property to copy.
  points.userData.hideInBloom = true;
  return { points, material: mat, count };
}

export async function createStars() {
  const group = new THREE.Group();
  const cat = await loadCatalogue(SHELL_RADIUS);
  group.add(cat.points);

  // three's rotation.y = alpha maps theta -> theta - alpha, and a star sits at
  // theta = gmst - ra, so the group turns by MINUS the sidereal angle.
  function applyTime(date) {
    group.rotation.y = -(gmstDegrees(date) * Math.PI) / 180;
  }
  applyTime(new Date());

  let sinceSync = 0;
  return {
    group,
    count: cat.count,
    setPixelScale(v) {
      cat.material.uniforms.pixelScale.value = v;
    },
    update(dt) {
      // The sky turns 15 arcseconds a second. Re-syncing every 5s is far finer
      // than a pixel and costs one trig call.
      sinceSync += dt;
      if (sinceSync < 5) return;
      sinceSync = 0;
      applyTime(new Date());
    },
  };
}
