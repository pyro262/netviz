// Sky geometry: real equatorial coordinates, real sidereal rotation, real star
// colors. Kept free of three.js so it runs under `node --test`; stars.js turns
// what is here into geometry.
//
// The stars used to be uniform random points. They are now the HYG catalogue to
// magnitude 6.5 (tools/bake_stars.py), placed by right ascension and
// declination and turned by Greenwich sidereal time, so the constellations are
// the real ones in their real orientation for the current moment.

const DEG = Math.PI / 180;

/** Scene direction for an equatorial coordinate at sidereal time zero.
 *  Uses the globe's own convention -- theta = -lon -- so a star and a point on
 *  the ground agree about which way east is. */
export function equatorialToVec(raDeg, decDeg) {
  const phi = (90 - decDeg) * DEG;
  const theta = -raDeg * DEG;
  return [
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ];
}

/** Greenwich mean sidereal time in degrees. Same series sun.js uses for the
 *  subsolar longitude, so the sky and the terminator cannot disagree. */
export function gmstDegrees(date) {
  const n = date.getTime() / 86400000 - 10957.5;      // days since J2000.0
  const hours = (18.697374558 + 24.06570982441908 * n) % 24;
  return ((hours * 15) % 360 + 360) % 360;
}

/** Where a star is right now, in the scene frame. */
export function starDirection(raDeg, decDeg, date) {
  return equatorialToVec(raDeg - gmstDegrees(date), decDeg);
}

/** North galactic pole in equatorial coordinates: RA 12h51m26s, Dec +27d07m42s
 *  (J2000). The Milky Way band is drawn perpendicular to this, so it crosses
 *  the sky where it actually does rather than at a chosen angle. */
export const GALACTIC_POLE = equatorialToVec(192.859508, 27.128336);

/**
 * Approximate RGB for a B-V color index. Piecewise fit to the usual
 * blackbody-to-sRGB tables: about right at O/B (blue-white) through M (orange-
 * red), which is all that survives being drawn as a 2-pixel point anyway.
 * Unknown indices arrive as 0, which lands sun-like, and that is the safe miss.
 */
export function bvToRgb(bv) {
  const t = Math.max(-0.4, Math.min(2.0, bv));
  // Rough color temperature from B-V (Ballesteros' formula), then a simple
  // ramp. Clamped hard: the tails of any such fit go out of gamut.
  const k = 4600 * (1 / (0.92 * t + 1.7) + 1 / (0.92 * t + 0.62));
  const x = Math.max(1000, Math.min(40000, k)) / 100;

  let r;
  let g;
  let b;
  if (x <= 66) {
    r = 1;
    g = 0.39008157 * Math.log(x) - 0.63184144;
  } else {
    r = 1.29293618 * ((x - 60) ** -0.1332047592);
    g = 1.12989086 * ((x - 60) ** -0.0755148492);
  }
  if (x >= 66) b = 1;
  else if (x <= 19) b = 0;
  else b = 0.54320679 * Math.log(x - 10) - 1.19625408;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  // Lifted toward white: at full saturation a sky of 9000 points reads as
  // confetti rather than as stars.
  return [clamp(r), clamp(g), clamp(b)].map((c) => clamp(0.35 + 0.65 * c));
}

/** Point size for a magnitude. Brightness is logarithmic, so this is too:
 *  a linear map makes Sirius a dot and mag 6 stars invisible, or everything a
 *  blob. */
export function magnitudeToSize(mag) {
  return Math.max(0.62, 3.7 - 0.44 * (mag + 1.5));
}

/** Alpha for a magnitude: the faintest stars must be present but barely.
 *  Lifted ~30% on 2026-08-09 against a darkened background -- the sky got
 *  darker, so the stars had room to carry more of the contrast. */
export function magnitudeToAlpha(mag) {
  return Math.max(0.26, Math.min(1, 1.35 - 0.15 * (mag + 1.5)));
}

/**
 * A direction biased toward the galactic plane, for the faint unresolved stars
 * that MAKE the Milky Way. The painted band alone read as a glow; the band is
 * physically a haze of stars too faint to resolve, so drawing some is both
 * truer and better looking than turning the glow up.
 *
 * @param rng   () => [0,1)
 * @param bias  0 = uniform sphere, 1 = every point in the band. Points still
 *              land outside it at any bias -- a stripe with empty sky either
 *              side looks painted on.
 */
export function sampleBandDirection(rng, bias = 0.8) {
  const [px, py, pz] = GALACTIC_POLE;
  // An orthonormal basis with the pole as its third axis.
  const seed = Math.abs(px) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let a = [
    seed[1] * pz - seed[2] * py,
    seed[2] * px - seed[0] * pz,
    seed[0] * py - seed[1] * px,
  ];
  const an = Math.hypot(...a);
  a = a.map((c) => c / an);
  const b = [py * a[2] - pz * a[1], pz * a[0] - px * a[2], px * a[1] - py * a[0]];

  let u;
  if (rng() < bias) {
    // Three samples averaged gives a rough bell around the plane without
    // needing a Gaussian.
    u = ((rng() + rng() + rng()) / 3 - 0.5) * 0.62;
  } else {
    u = rng() * 2 - 1;                  // uniform in cos -> uniform on sphere
  }
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  const th = rng() * Math.PI * 2;
  const ca = r * Math.cos(th);
  const cb = r * Math.sin(th);
  return [
    a[0] * ca + b[0] * cb + px * u,
    a[1] * ca + b[1] * cb + py * u,
    a[2] * ca + b[2] * cb + pz * u,
  ];
}

/** Share of directions within `degrees` of the galactic plane. Test support --
 *  the only honest way to say whether the band is actually there. */
export function bandFraction(dirs, degrees) {
  const limit = Math.sin((degrees * Math.PI) / 180);
  const [px, py, pz] = GALACTIC_POLE;
  let n = 0;
  for (const v of dirs) {
    if (Math.abs(v[0] * px + v[1] * py + v[2] * pz) <= limit) n += 1;
  }
  return n / dirs.length;
}

// ---------------------------------------------------------------- galactic --
//
// The Milky Way band is not drawn at a chosen angle: it is where the galactic
// plane actually is. These three vectors are the galactic frame's own axes,
// each given by its REAL J2000 equatorial coordinate and mapped through
// equatorialToVec, so all three land in the scene frame with the same
// theta = -ra convention every other sky object uses.
//
// Y is a literal, not `Z cross X`. equatorialToVec is a mirror (theta = -ra),
// which reverses the handedness of a cross product taken after it, so the
// obvious construction yields a frame in which galactic longitude runs
// backwards -- an error that looks like a perfectly good Milky Way until you
// notice Sagittarius rising in the wrong place. A dot product, by contrast, is
// preserved exactly by any orthogonal map including a mirror, so components
// taken against these three axes are the true galactic ones.

/** Galactic centre, l=0 b=0: RA 17h45m37.2s, Dec -28d56m10s (J2000). */
export const GALACTIC_X = equatorialToVec(266.40500, -28.93617);
/** l=90 b=0: RA 21h12m01.0s, Dec +48d19m47s (J2000). */
export const GALACTIC_Y = equatorialToVec(318.00426, 48.32964);
/** North galactic pole, b=+90: RA 12h51m26.3s, Dec +27d07m42s (J2000).
 *  Same vector as GALACTIC_POLE, named for the frame it belongs to. */
export const GALACTIC_Z = equatorialToVec(192.85948, 27.12825);

/** Galactic (l, b) in degrees for a direction already in the scene frame.
 *  l is wrapped to [0, 360). */
export function vecToGalactic(v) {
  const dot = (a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const x = dot(GALACTIC_X);
  const y = dot(GALACTIC_Y);
  const z = dot(GALACTIC_Z);
  const b = Math.asin(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z)))) / DEG;
  const l = ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
  return [l, b];
}

/** Galactic (l, b) in degrees for an equatorial J2000 coordinate. The check
 *  that matters: Sgr A* must come back at l~0, b~0 and the north galactic pole
 *  at b=+90, and tests assert exactly that against published values. */
export function equatorialToGalactic(raDeg, decDeg) {
  return vecToGalactic(equatorialToVec(raDeg, decDeg));
}
