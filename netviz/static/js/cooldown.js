// Per-target rate limit for impact ripples.
//
// Nearly every inbound arc lands on the same point -- home -- so one ripple per
// arrival meant a permanent pulse there rather than an event worth noticing.
// One ripple per target per two minutes makes a ripple mean "something started
// happening here" again.
//
// No three.js, so it runs under `node --test`.

/** Targets within a cell share one cooldown. 1 degree is ~110 km: GeoIP jitters
 *  a city's coordinates between records, and those are the same place. */
const CELL_DEGREES = 1;

export function createCooldown(initialSeconds, cell = CELL_DEGREES) {
  let seconds = initialSeconds;
  const last = new Map();
  let lastPrune = -Infinity;

  function key(lat, lon, className) {
    const a = Math.round(lat / cell);
    const o = Math.round(lon / cell);
    // Class is part of the key so a steady trickle of flows into a target
    // cannot swallow the block ripple that lands there -- blocks are what the
    // wall is for.
    return `${a}:${o}:${className}`;
  }

  function prune(now) {
    for (const [k, t] of last) {
      if (now - t >= seconds) last.delete(k);
    }
  }

  return {
    /** True if this landing should draw, and records it. False suppresses.
     *  A suppressed landing does NOT extend the window: otherwise a busy
     *  target would never ripple again. */
    allow(lat, lon, className, now) {
      // Sweep once per window. Size alone is not enough: a display that runs
      // for months accumulates one entry per distinct target forever, and most
      // of them are one-off peers that will never be seen again.
      if (now - lastPrune >= seconds) {
        prune(now);
        lastPrune = now;
      }
      const k = key(lat, lon, className);
      const prev = last.get(k);
      if (prev !== undefined && now - prev < seconds) return false;
      last.set(k, now);
      return true;
    },
    /** Live, because the window is a setting. Shortening it does not
     *  retroactively release the targets already recorded -- the next allow()
     *  compares against the new window, which is what "shorter from now on"
     *  means. */
    setSeconds(v) { seconds = v; },
    size() {
      return last.size;
    },
  };
}
