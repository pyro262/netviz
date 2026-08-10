// Poll timing that matches the cadence of the thing being polled.
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
