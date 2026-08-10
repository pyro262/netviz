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
