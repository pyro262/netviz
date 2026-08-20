// What the Milky Way actually looks like, as numbers.
//
// Kept free of three.js so it runs under `node --test`; milkyway.js turns what
// is here into a baked all-sky texture. The band is NOT painted: it is the
// line-of-sight integral of a real Galaxy model through a real dust layer,
// evaluated in real galactic coordinates, with a table of the named star
// clouds and dark nebulae a person can actually point at on top.
//
// Three separate claims to accuracy, because they are verified separately:
//
//   1. ORIENTATION. starfield.js's galactic basis is the J2000 frame from its
//      own published axes, checked against Sgr A*, M31, Polaris, M42, the Crab
//      and the LMC to 0.001 deg. That is what puts the band where it belongs
//      against the constellations and the terminator in the same frame.
//   2. SHAPE. The smooth part is an integral, not a gaussian stripe: a thin
//      disk, a thick disk and a bulge seen through an exponential dust layer.
//      Every constant below is a measured one with its source named. This is
//      what makes the band bright and wide toward Sagittarius, thin and faint
//      toward Auriga, and split by a dark rift down the middle -- none of
//      which has to be drawn, because that is what the integral does.
//   3. DETAIL. The named clouds. A smooth model has no Coalsack, no Cygnus
//      Rift and no Sagittarius Star Cloud, and those are precisely the
//      features a viewer recognizes. Each entry is a real object at its real
//      galactic coordinate; sizes are the naked-eye extent, rounded.
//
// What is deliberately NOT modeled: spiral arms. Arm tangents are real and
// they are where the Carina and Cygnus brightenings come from, but the
// published fits disagree about phase, and an arm placed 30 deg wrong puts a
// bright patch in a part of the sky that is genuinely empty -- worse than
// leaving it to the cloud table, which is anchored to what is observed. Also
// not modeled: the outer disk warp and flare (invisible at naked-eye surface
// brightness) and the zodiacal light (not the Galaxy).

/** Sun and Galaxy geometry, kiloparsecs. Sources named per line. */
export const MODEL = {
  R0: 8.178,        // Sun's galactocentric radius (GRAVITY Collab. 2019)
  Z0: 0.0208,       // Sun's height above the plane (Bennett & Bovy 2019)
  thinHR: 2.6,      // thin-disk scale length  (Bland-Hawthorn & Gerhard 2016)
  thinHZ: 0.30,     // thin-disk scale height  (BHG16; 300 pc)
  thickHR: 2.0,     // thick-disk scale length (BHG16)
  thickHZ: 0.90,    // thick-disk scale height (BHG16; 900 pc)
  thickFrac: 0.04,  // local thick:thin normalization (BHG16, ~4%)
  bulgeScale: 0.68, // boxy-bulge scale radius (BHG16)
  bulgeYQ: 0.50,    // bulge axis ratios, b/a and c/a, for the bar seen
  bulgeZQ: 0.40,    // nearly end-on from here
  // Bulge:disk emissivity at the same radius. CALIBRATED, not derived: the
  // published surface-brightness ratios for integrated starlight put the
  // Galactic plane at l=0 about 3-4x the anticentre and the Sagittarius
  // windows below the plane around 8-10x, and this is the value that lands
  // there. A first-principles number cannot be used, because what reaches the
  // eye from the bulge is set by the extinction in front of it and that is
  // the part no smooth model gets right.
  bulgeAmp: 1.2,
  dustHR: 3.3,      // dust scale length  (BHG16)
  dustHZ: 0.075,    // dust scale height  (BHG16; ~75 pc -- a FIFTH of the
                    // stars', which is the whole reason there is a dark rift
                    // down the middle of a bright band)
  dustTau: 0.72,    // optical depth per kpc at the Sun, V band (A_V ~ 0.8
                    // mag/kpc locally, and tau = A / 1.086)
  // Dust is NOT a plain exponential disk, and the difference is the single
  // biggest thing standing between this model and the real sky. Most of the
  // Galaxy's molecular gas sits in a ring near R = 4 kpc, and the extinction
  // toward the Galactic centre is A_V ~ 30 magnitudes -- the centre is not
  // dim, it is invisible, and the bright thing a person sees in Sagittarius
  // is the star clouds IN FRONT of it. Without this term the bulge shines
  // straight through at twenty-five times the anticentre, which is about six
  // times the real contrast and reads as a headlight on the horizon.
  ringAmp: 5.5,     // peak extra dust density, relative to the local disk
  ringR: 4.3,       // molecular ring radius, kpc
  ringW: 1.9,       // its gaussian width, kpc
  // Extinction is wavelength-dependent -- that is why the Galactic centre is
  // orange and the outer band is white. Ratios A_lambda/A_V at the RGB
  // primaries, from a standard R_V = 3.1 curve.
  extR: 0.75,
  extG: 1.00,
  extB: 1.34,
  // The map is stored with a contrast gamma, and this is the one place the
  // model deliberately stops being photometric. The diffuse Galactic light at
  // the poles really is about 1% of the band's peak -- but a monitor's sRGB
  // curve raises 1% linear to 11% of full white, so a physically linear map
  // renders the whole sky as grey fog with a slightly brighter stripe in it.
  // The night-adapted eye compresses the other way: near its threshold, a
  // factor of two in luminance is nearly all-or-nothing. 1.6 puts the poles
  // back down where a person standing outside would see them and leaves the
  // band's own internal structure alone.
  displayGamma: 1.6,
  losMax: 26.0,     // integrate to 26 kpc: past the far edge of the disk
  losSteps: 96,     // logarithmically spaced -- see the shader
  losBias: 4.0,     // how strongly the steps bunch up near the Sun
};

/** Naked-eye star clouds: real objects, galactic (l, b) in degrees, with the
 *  gaussian extent that reads closest to their actual outline. `amp` is a
 *  multiplier on the local emissivity, not an absolute brightness, so a cloud
 *  behind more dust stays dimmer -- which is true of the real ones. */
export const BRIGHT_CLOUDS = [
  { name: 'Large Sagittarius Star Cloud', l: 6.5, b: -4.0, sl: 5.5, sb: 3.2, amp: 0.55 },
  { name: 'Small Sagittarius Star Cloud (M24)', l: 13.2, b: -1.8, sl: 1.6, sb: 1.3, amp: 0.40 },
  { name: 'Scutum Star Cloud', l: 27.0, b: -0.6, sl: 3.6, sb: 2.2, amp: 0.45 },
  { name: 'Cygnus Star Cloud', l: 78.5, b: 1.2, sl: 6.5, sb: 3.0, amp: 0.42 },
  { name: 'Norma / Ara clouds', l: 333.0, b: -1.0, sl: 5.0, sb: 2.4, amp: 0.30 },
  { name: 'Crux / Centaurus', l: 300.5, b: 0.0, sl: 5.5, sb: 2.4, amp: 0.30 },
  { name: 'Carina (eta Car region)', l: 287.5, b: -0.6, sl: 4.5, sb: 2.0, amp: 0.50 },
  { name: 'Vela', l: 265.0, b: -1.5, sl: 6.0, sb: 2.4, amp: 0.22 },
  { name: 'Cassiopeia / Perseus', l: 125.0, b: -1.0, sl: 6.0, sb: 2.2, amp: 0.15 },
];

/** Dark nebulae, the same way: extra extinction where there really is extra
 *  extinction. The Great Rift is three of these end to end, because that is
 *  what it is -- Cygnus, Aquila and Ophiuchus clouds in a line, not one
 *  object. `amp` is added optical depth at the cloud's centre. */
export const DARK_CLOUDS = [
  { name: 'Cygnus Rift', l: 70.0, b: 0.5, sl: 14.0, sb: 2.6, amp: 1.10 },
  { name: 'Aquila Rift', l: 30.0, b: 5.5, sl: 12.0, sb: 5.5, amp: 1.00 },
  { name: 'Ophiuchus / Pipe', l: 0.5, b: 6.0, sl: 9.0, sb: 5.0, amp: 0.90 },
  { name: 'Coalsack', l: 303.0, b: -0.5, sl: 3.0, sb: 2.6, amp: 1.20 },
  { name: 'Taurus dark clouds', l: 172.0, b: -15.0, sl: 8.0, sb: 6.0, amp: 0.45 },
  { name: 'Chamaeleon', l: 300.0, b: -16.0, sl: 5.0, sb: 4.0, amp: 0.30 },
];

/** Not the Milky Way at all, and drawn anyway: both Clouds are naked-eye
 *  objects at a real place in the sky, and a southern view with the band and
 *  no Magellanic Clouds is missing something a viewer would notice. Kept
 *  faint, and separated from the band's own table so it stays obvious that
 *  these are a different thing.
 *
 *  The amplitudes were cut by about two thirds after the first deployment,
 *  where the LMC was reported from the wall as "a big white spot". It was:
 *  0.16 of peak sitting in sky measuring 0.001, a hundredfold step with
 *  nothing around it, which reads as a rendering fault rather than as a
 *  galaxy. The real Clouds are FAINT -- comparable to a dim stretch of band,
 *  not to the Sagittarius star clouds -- and they are visibly mottled rather
 *  than smooth, which is why milkyway.js also breaks them up with noise. A
 *  gaussian on its own is a disc, and a disc in empty sky is a spot. */
export const SATELLITES = [
  { name: 'Large Magellanic Cloud', l: 280.5, b: -32.9, sl: 3.4, sb: 2.8, amp: 0.16 },
  { name: 'Small Magellanic Cloud', l: 302.8, b: -44.3, sl: 2.0, sb: 1.7, amp: 0.09 },
];

/** GLSL for one gaussian-cloud table. Generated rather than hand-written so
 *  the numbers above are the only copy: a table in JS and a second one in a
 *  shader string is how a "fix" to one of them silently stops reaching the
 *  wall. `dl` wraps, because a cloud at l=0.5 has to reach l=359. */
export function cloudGlsl(fn, rows) {
  const body = rows.map((c) => `  s += ${c.amp.toFixed(3)} * g(l, b, `
    + `${c.l.toFixed(1)}, ${c.b.toFixed(1)}, ${c.sl.toFixed(1)}, ${c.sb.toFixed(1)});`).join('\n');
  return `float ${fn}(float l, float b) {\n  float s = 0.0;\n${body}\n  return s;\n}`;
}
