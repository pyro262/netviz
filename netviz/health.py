"""Per-feed staleness. Emits transitions only, so alerting can be wired
straight to evaluate() without a job that cries wolf every minute."""
from typing import Optional


class Health:
    def __init__(self, thresholds: dict[str, float]) -> None:
        self._thresholds = dict(thresholds)
        self._last: dict[str, Optional[float]] = {f: None for f in thresholds}
        self._stale: dict[str, bool] = {f: False for f in thresholds}

    def saw(self, feed: str, now: float) -> None:
        if feed in self._last:
            self._last[feed] = now

    def _is_stale(self, feed: str, now: float) -> bool:
        last = self._last[feed]
        if last is None:
            return True
        return (now - last) > self._thresholds[feed]

    def evaluate(self, now: float) -> list[tuple[str, str]]:
        transitions: list[tuple[str, str]] = []
        for feed in self._thresholds:
            stale = self._is_stale(feed, now)
            if stale != self._stale[feed]:
                self._stale[feed] = stale
                transitions.append((feed, "stale" if stale else "recovered"))
        return transitions

    def status(self, now: float) -> dict[str, dict]:
        return {
            feed: {
                "ok": not self._is_stale(feed, now),
                "last_good": self._last[feed],
                "age": (now - self._last[feed]) if self._last[feed] is not None else None,
            }
            for feed in self._thresholds
        }


class RatioAlert:
    """Entry/recovery transitions for a ratio condition (e.g. GeoIP miss
    rate), using the exact same once-on-entry/once-on-recovery discipline
    as Health.evaluate() -- transitions only, never repeats while the
    condition persists -- so callers (the alerter task) have a single
    alerting path instead of a second bespoke one for ratios.

    evaluate() is fed cumulative-since-boot counters (that's what
    enricher.stats holds), but the ratio is judged over the *window since
    the previous call*, not the lifetime total. A lifetime ratio has two
    failure modes: after weeks of healthy operation, a newly broken .mmdb
    can't move the cumulative rate past the threshold for days (the
    numerator is huge, the increment is tiny), and conversely one bad
    early window latches the breached state forever because the lifetime
    ratio it fed can never fall back below threshold once enough misses
    have accumulated. Tracking the delta between consecutive calls fixes
    both: each call judges only what happened since the last one.

    A minimum sample count guards against a handful of lookups in one
    window (e.g. a quiet period) tripping the alert before there is
    enough signal in that window to trust the ratio.

    `dwell` is how many CONSECUTIVE windows the condition must hold
    before a transition is emitted, in each direction. One window is
    noise: measured on a live install 2026-09-22, a lifetime miss rate
    of 4.0% still produced thirteen stale/recovered alert pairs in six
    hours, nearly all of them one or two windows long, because something
    hourly burst-queries addresses the database cannot place. Nothing
    was broken; the alert simply had no dwell. A window that is under
    `min_samples` carries no information either way, so it neither
    advances the dwell counter nor resets it."""

    def __init__(self, name: str, threshold: float, min_samples: int,
                 dwell: int = 1) -> None:
        self.name = name
        self._threshold = threshold
        self._min_samples = min_samples
        self._dwell = max(1, dwell)
        self._breached = False
        self._streak = 0
        self._prev_misses = 0
        self._prev_hits = 0

    def evaluate(self, misses: int, hits: int) -> list[tuple[str, str]]:
        # max(0, ...) guards against a counter reset (e.g. process
        # restart with a fresh enricher but a RatioAlert that somehow
        # outlived it) producing a negative delta.
        d_misses = max(0, misses - self._prev_misses)
        d_hits = max(0, hits - self._prev_hits)
        self._prev_misses = misses
        self._prev_hits = hits

        attempts = d_misses + d_hits
        if attempts < self._min_samples:
            return []
        rate = d_misses / attempts
        breach = rate > self._threshold
        if breach == self._breached:
            # Already in that state -- any partial run toward the other
            # one is over.
            self._streak = 0
            return []
        self._streak += 1
        if self._streak < self._dwell:
            return []
        self._breached = breach
        self._streak = 0
        return [(self.name, "stale" if breach else "recovered")]
