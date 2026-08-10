// Three layers, because each fixes what the others cannot: baked textures for
// land mass and the terminator; line geometry for coastlines, which stay 1px
// crisp at the limb where texture filtering turns to mush; point sprites for
// city lights, because points take bloom and texels do not.
import * as THREE from 'three';
import { cfg } from './config.js';
import { plasmaAt } from './palette.js';

/** Geographic to cartesian. Lon 0 faces +X, north pole is +Y, and longitude
 *  runs NEGATIVE around +Y -- i.e. theta = -lon.
 *
 *  The sign is the whole ballgame. With theta = +lon the frame is left-handed
 *  for a camera outside the sphere with north up: east renders on the LEFT and
 *  every continent is a mirror image of itself. It also disagrees with
 *  SphereGeometry's own uv mapping, which forces a compensating flip in the
 *  texture lookup and hides the problem by making everything consistently
 *  wrong. With theta = -lon this matches both reality and `uv.x` directly.
 *  camera.js and sun.js inline the same trig and must keep the same sign. */
export function latLonToVec3(lat, lon, radius) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(-lon);
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The terminator is real shading, not a drawn line: a soft band across
// dot(normal, sunDir), blending the day texture into the night-lights texture.
const FRAG = /* glsl */`
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDir;
  uniform float softness;   // radians of blend, ~5 degrees
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    float d = dot(normalize(vNormalW), normalize(sunDir));
    float lit = smoothstep(-softness, softness, d);
    // Sampled directly: SphereGeometry's uv.x agrees with the bake's
    // u = (lon+180)/360 now that latLonToVec3 uses theta = -lon. An earlier
    // build flipped this instead of fixing the sign, which mirrored the whole
    // globe while keeping the layers agreeing with each other.
    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    vec3 c = mix(night, day * (0.55 + 0.45 * lit), lit);
    gl_FragColor = vec4(c, 1.0);
  }
`;

async function loadTexture(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

async function loadCoastlines(radius) {
  const buf = await (await fetch('/data/coastline.bin')).arrayBuffer();
  const f = new Float32Array(buf);
  const positions = new Float32Array((f.length / 2) * 3);
  for (let i = 0, o = 0; i < f.length; i += 2, o += 3) {
    // Slightly above the surface so the line never z-fights the texture.
    const v = latLonToVec3(f[i], f[i + 1], radius * 1.0015);
    positions[o] = v.x; positions[o + 1] = v.y; positions[o + 2] = v.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: plasmaAt(0.42), transparent: true, opacity: 0.85,
  });
  return new THREE.LineSegments(geom, mat);
}

/** Outlines of the 21 geo-blocked countries.
 *
 *  Deliberately not every border on earth: a second full line system would
 *  compete with the coastlines on a display read from across a room and would
 *  say nothing. These say which regions the firewall blocks, so a block arc
 *  lands in a shape you recognise. Kept OFF the bloom layer and dim -- context,
 *  not a feature competing with the arcs. */
async function loadBorders(radius) {
  // Absent by design on a fresh clone: which countries somebody's firewall
  // watches is site-specific, so the bake output for this layer is not
  // committed (see tools/bake_geo.py and .gitignore). Return null rather than
  // throwing -- an install that has not baked its own list gets every other
  // layer, not a globe that fails to boot.
  let buf;
  let index;
  try {
    const [bufRes, idxRes] = await Promise.all([
      fetch('/data/borders.bin'), fetch('/data/borders-index.json'),
    ]);
    if (!bufRes.ok || !idxRes.ok) return null;
    buf = await bufRes.arrayBuffer();
    index = await idxRes.json();
  } catch {
    return null;
  }
  if (!buf.byteLength) return null;
  const f = new Float32Array(buf);
  const positions = new Float32Array((f.length / 2) * 3);
  for (let i = 0, o = 0; i < f.length; i += 2, o += 3) {
    // Just under the coastlines (1.0015) so the two never z-fight.
    const v = latLonToVec3(f[i], f[i + 1], radius * 1.0012);
    positions[o] = v.x; positions[o + 1] = v.y; positions[o + 2] = v.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Amber, the block-arc colour knocked well back. "Blocked" is now one visual
  // language across the whole display: this outline, the arc that lands in it,
  // its impact ripple and the flash on arrival are all the same hue, so the
  // shape a block lands in is recognisable as the thing the arc is about.
  // Violet was indistinguishable from the world-border layer, which is exactly
  // what these are meant NOT to be.
  const mat = new THREE.LineBasicMaterial({
    color: plasmaAt(0.86).multiplyScalar(0.62), transparent: true,
    opacity: 0.5, depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);

  // Flash overlays share the ONE border geometry and address a single country
  // through drawRange -- which is why the bake emits segments grouped by
  // country. Four of them, so simultaneous blocks from different countries do
  // not steal each other's flash.
  const flashes = [];
  for (let i = 0; i < 4; i += 1) {
    const fmat = new THREE.LineBasicMaterial({
      color: plasmaAt(0.86), transparent: true, opacity: 0, depthWrite: false,
    });
    const seg = new THREE.LineSegments(geom, fmat);
    seg.layers.enable(1);          // the flash glows; the dim outline does not
    seg.visible = false;
    seg.frustumCulled = false;     // drawRange confuses the computed bounds
    flashes.push({ seg, mat: fmat, age: 0, active: false });
  }
  return { lines, flashes, index };
}

/** Every international land border on earth.
 *
 *  Sits under the blocked-country outlines at roughly half their brightness,
 *  so the 21 the firewall acts on still read as a distinct layer instead of
 *  dissolving into the world map. Same radius trick, same bloom exclusion. */
async function loadAllBorders(radius) {
  const buf = await (await fetch('/data/borders-all.bin')).arrayBuffer();
  const f = new Float32Array(buf);
  const positions = new Float32Array((f.length / 2) * 3);
  for (let i = 0, o = 0; i < f.length; i += 2, o += 3) {
    // Just below borders.bin (1.0012) so the blocked outlines win any overlap.
    const v = latLonToVec3(f[i], f[i + 1], radius * 1.0009);
    positions[o] = v.x; positions[o + 1] = v.y; positions[o + 2] = v.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: plasmaAt(0.24), transparent: true, opacity: 0.20, depthWrite: false,
  });
  return new THREE.LineSegments(geom, mat);
}

/** US state and Canadian province boundaries. Dimmest of the three line
 *  layers -- home is in North America, so this is the region where sub-national shape
 *  helps place an arc root, and it must not out-shout the international
 *  borders around it. */
async function loadAdmin1(radius) {
  const buf = await (await fetch('/data/admin1.bin')).arrayBuffer();
  const f = new Float32Array(buf);
  const positions = new Float32Array((f.length / 2) * 3);
  for (let i = 0, o = 0; i < f.length; i += 2, o += 3) {
    const v = latLonToVec3(f[i], f[i + 1], radius * 1.0007);
    positions[o] = v.x; positions[o + 1] = v.y; positions[o + 2] = v.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: plasmaAt(0.26), transparent: true, opacity: 0.22, depthWrite: false,
  });
  return new THREE.LineSegments(geom, mat);
}

async function loadCityPoints(radius) {
  const cities = await (await fetch('/data/cities.json')).json();
  const positions = new Float32Array(cities.length * 3);
  const colors = new Float32Array(cities.length * 3);
  const sizes = new Float32Array(cities.length);
  cities.forEach((c, i) => {
    const v = latLonToVec3(c.lat, c.lon, radius * 1.003);
    positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
    const col = plasmaAt(0.72 + 0.25 * c.w);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    sizes[i] = 1.5 + 5.0 * c.w;
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      // Points are sized in pixels, so the constant has to follow the canvas:
      // a fixed one that looks right at 1440p turns into blobs at 4K. main.js
      // sets this from the drawing buffer height on every resize.
      pixelScale: { value: 2.9 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float psize;
      uniform vec3 sunDir;
      uniform float pixelScale;
      varying vec3 vColor;
      varying float vNight;
      varying float vDusk;
      void main() {
        vColor = color;
        vec3 nrm = normalize(mat3(modelMatrix) * normalize(position));
        // Lights belong to the dark side only, faded across the terminator.
        float sun = dot(nrm, normalize(sunDir));
        vNight = 1.0 - smoothstep(-0.15, 0.25, sun);
        // Extra lift for cities sitting IN the terminator band rather than deep
        // in night. Real dusk is the brightest a city looks, and it gives the
        // day/night line visible motion instead of a static edge that lights
        // switch on behind.
        vDusk = smoothstep(0.30, 0.02, abs(sun + 0.02));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = psize * (pixelScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vNight;
      varying float vDusk;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        // 0.7: once the bloom-pass occlusion bug was fixed these lit up for
        // the first time and ran hot on the wall. Dimmed here rather than at
        // the composer so the arcs keep the bloom strength they were tuned at.
        float a = (1.0 - r * 2.0) * vNight * 0.7;
        // The dusk lift goes on the colour, not the alpha: alpha above 1 is
        // clamped and would do nothing, while a brighter colour carries
        // straight into the bloom pass, which is where dusk should show.
        gl_FragColor = vec4(vColor * (1.0 + 0.85 * vDusk), a);
      }
    `,
    vertexColors: true,
  });
  return new THREE.Points(geom, mat);
}

export async function createGlobe(radius) {
  const [dayMap, nightMap] = await Promise.all([
    loadTexture('/data/land.png'),
    loadTexture('/data/night.png'),
  ]);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      softness: { value: 0.09 },   // ~5 degrees
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const group = new THREE.Group();
  const surface = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 96), material);
  // Each line layer is optional (config.js `layers`). A disabled layer is not
  // fetched at all -- these are the largest assets on the page.
  const coastlines = cfg('layers.coastline', true) ? await loadCoastlines(radius) : null;
  const admin1 = cfg('layers.admin1', true) ? await loadAdmin1(radius) : null;
  const allBorders = cfg('layers.bordersWorld', true) ? await loadAllBorders(radius) : null;
  const borders = cfg('layers.bordersWatched', true) ? await loadBorders(radius) : null;
  const cityPoints = cfg('layers.cityLights', true) ? await loadCityPoints(radius) : null;
  // Coastlines and city lights glow; the textured surface never does. Literal
  // 1 rather than post.js's BLOOM_LAYER so this file stays free of a
  // dependency on the post-processing module.
  if (coastlines) coastlines.layers.enable(1);
  if (cityPoints) cityPoints.layers.enable(1);
  group.add(surface);
  for (const layer of [coastlines, admin1, allBorders, borders && borders.lines, cityPoints]) {
    if (layer) group.add(layer);
  }
  if (borders) for (const f of borders.flashes) group.add(f.seg);

  const FLASH_LIFE = 2.0;

  /** Light up one blocked country's outline. Silently ignores a country with no
   *  outline -- a block can geolocate outside the watched set, since a router
   *  and this globe generally resolve addresses against different GeoIP
   *  databases and the two disagree on some ranges. Also a no-op when no
   *  watched-country bake exists at all. */
  function flashCountry(code) {
    if (!borders || !cfg('layers.countryFlash', true)) return;
    const range = code && borders.index[code];
    if (!range) return;
    const slot = borders.flashes.find((f) => !f.active) || borders.flashes[0];
    slot.seg.geometry.setDrawRange(range[0] * 2, range[1] * 2);   // 2 verts/segment
    slot.seg.visible = true;
    slot.mat.opacity = 0.95;
    slot.age = 0;
    slot.active = true;
  }

  function updateFlashes(dt) {
    if (!borders) return;
    for (const f of borders.flashes) {
      if (!f.active) continue;
      f.age += dt;
      const t = f.age / FLASH_LIFE;
      if (t >= 1) {
        f.active = false;
        f.seg.visible = false;
        continue;
      }
      // Hold bright briefly, then fall away -- a hard cut reads as a glitch.
      f.mat.opacity = 0.95 * (t < 0.25 ? 1 : 1 - (t - 0.25) / 0.75);
    }
  }

  return {
    group, material, coastlines, admin1, allBorders,
    borders: borders && borders.lines, cityPoints, surface,
    flashCountry, updateFlashes,
  };
}
