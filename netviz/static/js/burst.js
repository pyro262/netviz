// Detects a burst of blocks from one country -- the signal that sends the
// camera off to go and look at it.
//
// A single block must not move the camera: they arrive at all hours from
// scanners and stray connections, and a wall that jumps at each one is a wall
// nobody can read. A burst is different. Opening WeChat fires a dozen blocks to
// China inside a few seconds, and that is worth showing.
//
// Three-free, like classify.js and cooldown.js, so the thresholds can be
// asserted under `node --test`.
import { cfg } from './config.js';

export const BURST = {
  count: cfg('camera.detour.blocks', 5),                  // blocks from one country...
  windowSeconds: cfg('camera.detour.withinSeconds', 10),  // ...inside this window
  cooldownSeconds: cfg('camera.detour.quietSeconds', 120),// then it is quiet this long
};

/** Vector mean of a set of lat/lon points, in degrees.
 *
 *  Averaging the numbers directly is the wrap bug the camera centroid already
 *  avoids: a burst straddling the antimeridian (179 and -179) averages to 0,
 *  which is the Gulf of Guinea rather than Fiji. */
function meanPoint(points) {
  let x = 0; let y = 0; let z = 0;
  for (const p of points) {
    const lat = (p.lat * Math.PI) / 180;
    const lon = (p.lon * Math.PI) / 180;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  const n = points.length || 1;
  x /= n; y /= n; z /= n;
  const hyp = Math.hypot(x, y);
  return {
    lat: (Math.atan2(z, hyp) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/**
 * @returns an object with `add(country, lat, lon, t) -> {country, lat, lon}|null`.
 *          `t` is seconds, from any monotonic clock.
 */
export function createBurstDetector(p = BURST) {
  const recent = new Map();     // country -> [{t, lat, lon}], within the window
  const fired = new Map();      // country -> t of its last burst

  return {
    add(country, lat, lon, t) {
      // A block that could not be geolocated to a country cannot be visited,
      // and lumping them together under one key would invent a burst out of
      // unrelated events.
      if (!country) return null;

      const hits = recent.get(country) || [];
      hits.push({ t, lat, lon });
      while (hits.length && t - hits[0].t > p.windowSeconds) hits.shift();
      recent.set(country, hits);

      if (hits.length < p.count) return null;

      const last = fired.get(country);
      if (last !== undefined && t - last < p.cooldownSeconds) return null;

      fired.set(country, t);
      const point = meanPoint(hits);
      // Start counting again from empty. Otherwise a sustained burst re-fires
      // on the first event after every cooldown, which is a timer firing, not
      // a burst being detected.
      recent.set(country, []);
      return { country, lat: point.lat, lon: point.lon };
    },
  };
}
