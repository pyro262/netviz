// How much to dim a class of arcs when several of them overlap.
//
// The arcs blend additively, so N overlapping tubes are N times the brightness
// of one. Flows are rate-capped at 14/sec for exactly this reason. Blocks are
// never dropped -- the wall exists to show them -- so their count cannot be
// capped, and a burst (opening WeChat produces a dozen blocks to China on one
// corridor) glares while a single block arc reads perfectly.
//
// Three-free on purpose, like classify.js and cooldown.js, so the curve can be
// asserted under `node --test` instead of judged against one screenshot.

export const DENSITY = {
  // Below this, nothing is dimmed at all: one to four block arcs are the
  // ordinary case and already look right on the wall.
  ref: 4,
  // Never dim past this, however big the burst. At the floor a burst still
  // reads as brighter than the flat region -- 30 arcs at 0.25 sum to 7.5
  // against the flat 4 -- so "very busy" is still visible as very busy.
  floor: 0.25,
};

/** Opacity multiplier for `n` simultaneously live arcs of one class. */
export function densityGain(n, p = DENSITY) {
  if (n <= p.ref) return 1;
  return Math.max(p.floor, p.ref / n);
}
