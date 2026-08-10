// Subsolar point from UTC, low-precision NOAA/Astronomical Almanac formulae.
// Accurate to a fraction of a degree, which is far finer than a ~5 degree
// terminator blend can show. No three.js import so this stays unit-testable
// under `node --test`.

const DEG = Math.PI / 180;

/** Days since J2000.0 (2000-01-01 12:00 UTC). */
function daysSinceJ2000(date) {
  return date.getTime() / 86400000 - 10957.5;
}

/** Subsolar latitude (= solar declination) and longitude, both in degrees. */
export function subsolarPoint(date) {
  const n = daysSinceJ2000(date);

  const L = (280.460 + 0.9856474 * n) % 360;          // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;   // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;          // obliquity

  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;

  // Right ascension, then subtract Greenwich mean sidereal time to get the
  // longitude the sun is currently overhead.
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG;
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  let lon = ra - gmstHours * 15;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;         // wrap to [-180, 180)

  return { lat: dec, lon };
}

/** Sun altitude above the horizon at one place, in degrees.
 *
 *  Negative is below the horizon, so the zero crossing is sunrise or sunset --
 *  geometric, ignoring the ~0.83 degrees of refraction and solar radius that a
 *  published almanac time includes. That is about two minutes' difference at
 *  mid latitudes, far inside a 30-minute ramp. */
export function sunAltitude(date, lat, lon) {
  const { lat: dec, lon: sublon } = subsolarPoint(date);
  // Hour angle: how far the observer is from the meridian the sun is over.
  const H = (lon - sublon) * DEG;
  const sinAlt = Math.sin(lat * DEG) * Math.sin(dec * DEG)
               + Math.cos(lat * DEG) * Math.cos(dec * DEG) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG;
}

/** How far through the day it is at one place: 0 fully night, 1 fully day.
 *
 *  Ramps up over `rampMinutes` starting at sunrise, and down over the same
 *  span starting at sunset -- so the change happens while the sky is already
 *  changing, rather than jumping at the instant of the crossing.
 *
 *  Expressed through the sun's own rate of climb rather than through clock
 *  times: computing the altitude now and `rampMinutes` from now gives the
 *  altitude the ramp spans, which is what turns "30 minutes" into an angle
 *  without needing to solve for the sunrise time at all. The rate collapses
 *  toward zero inside the polar circles, where the sun can hang at one
 *  altitude for days; there the ramp degenerates to its endpoints, which is
 *  the honest answer.
 */
export function dayFraction(date, lat, lon, rampMinutes = 30) {
  const alt = sunAltitude(date, lat, lon);
  const later = new Date(date.getTime() + rampMinutes * 60000);
  const span = sunAltitude(later, lat, lon) - alt;

  if (Math.abs(span) < 1e-6) return alt > 0 ? 1 : 0;

  const rising = span > 0;
  // Rising: 0 at sunrise, 1 once the sun has climbed a ramp's worth.
  // Setting: 1 at sunset, 0 a ramp's worth below the horizon.
  const f = rising ? alt / span : 1 + alt / Math.abs(span);
  return Math.max(0, Math.min(1, f));
}

/** Unit vector toward the sun, in the same frame as globe.js latLonToVec3. */
export function sunDirection(date) {
  const { lat, lon } = subsolarPoint(date);
  const phi = (90 - lat) * DEG;
  const theta = -lon * DEG;      // sign per globe.js latLonToVec3
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
}
