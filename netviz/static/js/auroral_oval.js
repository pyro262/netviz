// The auroral oval's geometry, extracted from the shader so it can be checked.
//
// A fragment shader is unreviewable by any test we can run, so every number
// aurora.js's shader depends on is derived here and pinned by a node test --
// the same split js/schedule.js already uses for auroraFromReading. The shader
// re-implements these in GLSL; when you change one, change both, and let the
// test tell you which number moved.

// IGRF-13 north geomagnetic pole, epoch 2025. The southern oval is drawn about
// the antipode: the real south magnetic pole is NOT antipodal, but the dipole
// axis is what sets an oval, and the dipole has exactly two ends.
export const GEOMAG_POLE_LAT = 80.7;
export const GEOMAG_POLE_LON = -72.7;

// Altitudes as multiples of the Earth's radius. 100 km is 1.0157, 300 km is
// 1.047; the shader marches between these two and colors by where in the span
// a sample sits, which is the REAL axis of the green/red split. The old shader
// faked it latitudinally on a single shell and had nothing to show at the limb.
export const R_INNER = 1.016;
export const R_OUTER = 1.05;

const D2R = Math.PI / 180;

const norm = (v) => {
  const L = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
};
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The dipole axis, in globe.js's convention: theta = -lon. A +lon axis puts
 *  the pole 145 degrees of longitude away and still looks like an aurora. */
export function dipoleAxis() {
  const phi = (90 - GEOMAG_POLE_LAT) * D2R;
  const theta = -GEOMAG_POLE_LON * D2R;
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
}

/**
 * Where a direction sits in the magnetic frame.
 *
 * Both hemispheres run the same arithmetic against their own end of the dipole,
 * which is why `hemi` exists: everything downstream is written once and applies
 * to the southern oval unchanged.
 *
 * @param n unit direction from the planet's center
 * @param axis dipoleAxis()
 * @param sunDir unit vector toward the sun, same space as n
 * @returns { hemi: +1|-1, colat: degrees from that hemisphere's magnetic pole,
 *            mlt: magnetic local time in hours, 0 at magnetic MIDNIGHT }
 */
export function magneticFrame(n, axis, sunDir) {
  const a = norm(axis);
  const u = norm(n);
  const hemi = dot3(u, a) >= 0 ? 1 : -1;
  const m = { x: a.x * hemi, y: a.y * hemi, z: a.z * hemi };
  const colat = Math.acos(clamp(dot3(u, m), -1, 1)) / D2R;

  // Magnetic midnight is the anti-solar direction with the dipole component
  // removed. Near a solstice the sun can sit close to the axis, which makes
  // that projection short and its direction noisy -- fall back to any vector
  // perpendicular to the axis rather than normalizing something near zero.
  const s = norm(sunDir);
  let mid = {
    x: -s.x + m.x * dot3(s, m),
    y: -s.y + m.y * dot3(s, m),
    z: -s.z + m.z * dot3(s, m),
  };
  if (Math.hypot(mid.x, mid.y, mid.z) < 1e-6) {
    const alt = Math.abs(m.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    mid = cross3(m, alt);
  }
  mid = norm(mid);
  const east = norm(cross3(m, mid));
  const ang = Math.atan2(dot3(u, east), dot3(u, mid));   // 0 at midnight
  let mlt = (ang / D2R) * (24 / 360) + 24;
  mlt %= 24;
  return { hemi, colat, mlt };
}

/** The band's angular half-width at magnetic noon, in degrees. */
export const OVAL_WIDTH = 6.5;
/** How far equatorward magnetic midnight pulls the edge, in degrees. */
export const MIDNIGHT_OFFSET = 4.0;

/** cos of the hour angle from magnetic midnight: +1 at 0h, -1 at 12h. */
function midnightWeight(mlt) {
  return Math.cos((((mlt % 24) + 24) % 24) * (Math.PI / 12));
}

/**
 * Magnetic latitude of the oval's equatorward edge.
 *
 * At magnetic NOON this is exactly the collector's own oval_boundary() and
 * schedule.auroraFromReading()'s edgeLat: 66.5 - 1.7*Kp. The local-time term is
 * a departure from that baseline, never a replacement -- if the display and the
 * collector ever disagree about the quiet-sun edge they are describing two
 * different planets, and a test pins it.
 */
export function ovalEdge(kp, mlt) {
  const k = clamp(Number(kp) || 0, 0, 9);
  // (w + 1) / 2, not w: the local-time term has to vanish at NOON so the
  // baseline there is exactly the collector's formula, and reach its full
  // MIDNIGHT_OFFSET at midnight. A bare `w` swings symmetrically about noon
  // instead, which pushes the noon edge four degrees POLEWARD of the number
  // the collector computes -- the two halves of the system then disagree about
  // the quiet-sun edge while both look entirely reasonable on their own.
  const w = midnightWeight(mlt);
  return 66.5 - 1.7 * k - MIDNIGHT_OFFSET * ((w + 1) / 2);
}

/** How far past midnight, toward DAWN, the oval is brightest -- in hours of
 *  magnetic local time. Substorm onset is near 23-01 MLT and the auroral bulge
 *  expands poleward and westward from there, so the brightest sector in
 *  satellite imagery sits a little after midnight rather than exactly on it. */
export const PEAK_MLT = 1.3;

/** What fraction of peak brightness the DAYSIDE oval keeps. Not zero: the cusp
 *  aurora is real and continuous with the rest of the ring. It is simply faint,
 *  and daylight finishes the job -- the shader's night gate is a separate term. */
export const DAY_FLOOR = 0.12;

/**
 * Relative brightness of the oval at a given magnetic local time.
 *
 * THE OVAL IS A RING, AND THAT PART WAS ALREADY RIGHT -- the real thing is
 * called the auroral oval because it is one, a closed annulus about the
 * geomagnetic pole, and that is how it looks from orbit. What was wrong was
 * that it was drawn EVENLY around that ring. Auroral intensity is strongly
 * weighted to the midnight-through-dawn sector, where substorms break up; the
 * dayside is faint by comparison. An evenly lit ring reads as a drawn circle
 * rather than as aurora.
 *
 * Only INTENSITY lives here. The edge latitude and the band's width already
 * vary with local time -- see ovalEdge and ovalThickness -- and they are a
 * different fact about the same ring.
 */
export function ovalBrightness(mlt) {
  const hours = (((Number(mlt) || 0) % 24) + 24) % 24;
  // Cosine of the hour angle measured from the PEAK, not from midnight.
  const w = Math.cos(((hours - PEAK_MLT) * Math.PI) / 12);
  // (w+1)/2 maps to 0..1; the exponent sharpens the falloff so the bright
  // sector is a sector rather than half the ring.
  const shaped = ((w + 1) / 2) ** 1.6;
  return DAY_FLOOR + (1 - DAY_FLOOR) * shaped;
}

/** The band is about 60% wider in the midnight sector than at noon. */
export function ovalThickness(mlt) {
  return 1.0 + 0.3 * (1 + midnightWeight(mlt));
}

/** Both roots of |ro + t*rd| = R. rd must be normalized. */
export function raySphere(ro, rd, R) {
  const b = dot3(ro, rd);
  const c = dot3(ro, ro) - R * R;
  const disc = b * b - c;
  if (disc <= 0) return { hit: false, t0: 0, t1: 0 };
  const s = Math.sqrt(disc);
  return { hit: true, t0: -b - s, t1: -b + s };
}

/**
 * The span of a view ray worth sampling: inside the outer shell, in front of
 * the eye, and stopping at the planet.
 *
 * The planet clip is arithmetic and NOT a depth test, on purpose. An additive
 * shell drawn with depthTest on loses its near-side fragments to the globe's
 * own depth; drawn with depthTest off it paints the far-side oval straight
 * through the Earth -- the exact failure CLAUDE.md records from the Milky Way
 * shell. Clipping the ray is also strictly better than either: a column that
 * crosses the limb gets PARTIALLY occluded, which is what actually happens.
 *
 * @returns { start, end } or null when the ray never enters the shell
 */
export function marchSpan(ro, rd, R0, R1, R2) {
  const outer = raySphere(ro, rd, R2);
  if (!outer.hit) return null;
  const start = Math.max(outer.t0, 0);
  let end = outer.t1;
  if (end <= start) return null;
  const planet = raySphere(ro, rd, R0);
  if (planet.hit && planet.t0 > start) end = Math.min(end, planet.t0);
  if (end <= start) return null;
  return { start, end };
}
