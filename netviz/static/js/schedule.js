// The two pure decisions the NOAA planetary-K feed needs: when to ask again,
// and what to draw from an answer. aurora.js owns the mesh and the uniforms;
// neither of those decisions needs three, so both live here and are simulated
// under `node --test` rather than judged by watching a wall for three hours --
// the same split as campath.js/camera.js and orbit.js/input.js.
//
// Asking a source faster than it publishes is not freshness, it is just load:
// the planetary K-index lands on 3-hour boundaries, so a 5-minute poll asked
// the same question 36 times over. But polling at the period from an arbitrary
// start sits up to a full period behind, so the delay is aligned to fire just
// after each boundary instead.
//
// No three.js, so it runs under `node --test`.

/**
 * Milliseconds until just after the next boundary.
 *
 * @param nowMs    epoch milliseconds
 * @param periodMs the source's real publication interval
 * @param offsetMs how long after a boundary to fire, to let the publish settle
 * @param healthy  false when the last poll failed or returned nothing useful.
 *                 An unhealthy poller retries on `retryMs` instead: waiting
 *                 three hours to discover the collector came back would leave
 *                 the wall wrong for the whole period.
 * @param retryMs  the unhealthy retry interval
 */
export function nextPollDelay(nowMs, periodMs, offsetMs, healthy = true,
                              retryMs = 600_000) {
  if (!healthy) return retryMs;
  const since = ((nowMs - offsetMs) % periodMs + periodMs) % periodMs;
  const delay = periodMs - since;
  // Never 0: a zero delay spins the caller into a hot loop.
  return delay > 1000 ? delay : periodMs;
}

/**
 * What the aurora oval should look like for one reading.
 *
 * @param enabled the `layers.aurora` setting. It is a parameter and not an
 *        afterthought because this function is called again on EVERY poll, and
 *        a poll lands up to three hours after somebody turned the layer off
 *        (ten minutes on an unhealthy one). Deciding visibility from `kp` alone
 *        made the layer switch itself back on hours later while
 *        `CONFIG.layers.aurora` still said false -- a control that silently
 *        reverts, which is worse than one that never worked.
 * @param kp   the planetary K index, or null/undefined for no reading at all.
 * @param stale a reading too old to trust; drawn dimmer rather than confidently.
 *
 * No reading means NO aurora drawn. Kp 0 is a real, very quiet sky and would
 * still show a thin oval; "we cannot reach NOAA" must not.
 */
export function auroraFromReading({ enabled = true, kp = null, stale = false } = {}) {
  if (!enabled || kp === null || kp === undefined) return { visible: false };
  // Same rule as aurora.oval_boundary() on the collector: ~66.5 degrees
  // magnetic when quiet, ~1.7 degrees equatorward per Kp step.
  const edgeLat = 66.5 - 1.7 * Math.max(0, Math.min(9, kp));
  const s = Math.min(1, 0.25 + kp / 7);
  return { visible: true, edgeLat, strength: stale ? s * 0.4 : s };
}

/**
 * How strongly to draw a cloud field of a given age -- 1 current, 0 unusable.
 *
 * The globe's other live layer, the aurora, can simply stop when its reading
 * goes stale, because an aurora is an event: absent is a truthful answer.
 * Clouds are not. There is always weather, so a field that stops being drawn
 * says "clear skies everywhere", which is never true and is exactly what
 * somebody reading the wall would take from it. Fading across the last quarter
 * of the field's life is the honest middle: the weather visibly loses
 * confidence before it goes, instead of the planet clearing in one frame.
 *
 * NO AGE AT ALL IS 0, NOT 1. `null` is what /clouds.json reports before the
 * first successful fetch, and reading it as "brand new" would draw whatever
 * happened to be in the texture -- or nothing, confidently.
 *
 * @param age seconds since the field's coverage time, or null when never fetched
 * @param ttl how long the collector considers a field trustworthy
 */
export function cloudFade(age, ttl) {
  if (!(ttl > 0)) return 0;
  if (age === null || age === undefined || !(age >= 0)) return 0;
  const start = ttl * 0.75;
  if (age <= start) return 1;
  if (age >= ttl) return 0;
  return 1 - (age - start) / (ttl - start);
}
