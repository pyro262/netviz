"""Counters the right rail reads.

Everything here is in-memory and bounded: the rail wants "how many blocks in
the last 24 hours, from where" and "how many flows a minute", and neither
question is worth a round trip to Influx every 10 seconds from every kiosk.

The counters are bucketed rather than a list of events. A day of blocks at the
observed rate is tens of thousands of tuples to scan on every poll; 96 dicts
keyed by country is a fixed cost that does not grow with traffic.

Nothing here is on the ingest fast path's critical section -- note() is two
dict lookups -- and nothing here is persisted: a collector restart empties the
rail, which is honest, since a restart also empties the replay buffer and the
wall is a live display.
"""
import time
from typing import Any, Iterator, Optional

from .events import Event


class RollingCounter:
    """Counts labelled events over a moving window, in fixed buckets.

    The window is approximate by exactly one bucket: `slots` buckets are kept,
    of which the newest is partial, so the covered span runs between
    `(slots - 1) * bucket` and `slots * bucket` seconds. At the sizes used here
    (24h in 15-minute buckets, 60s in 1-second buckets) that is 23h45m-24h and
    59-60s respectively -- below the precision anyone reads off a wall.

    A slot holds the absolute bucket index it was written for, so a slot that
    has been lapped is cleared on next touch and never counted as live. That
    also makes a quiet period safe: no sweeper task is needed to expire buckets
    nothing is writing to.
    """

    def __init__(self, window: float, slots: int) -> None:
        if slots < 1:
            raise ValueError("slots must be >= 1")
        if window <= 0:
            raise ValueError("window must be > 0")
        self.window = float(window)
        self.slots = int(slots)
        self.bucket = self.window / self.slots
        self._epoch: list[Optional[int]] = [None] * self.slots
        self._counts: list[dict[str, int]] = [{} for _ in range(self.slots)]

    def _index(self, now: float) -> int:
        return int(now // self.bucket)

    def add(self, label: str, now: float, n: int = 1) -> None:
        epoch = self._index(now)
        slot = epoch % self.slots
        if self._epoch[slot] != epoch:
            self._epoch[slot] = epoch
            self._counts[slot] = {}
        counts = self._counts[slot]
        counts[label] = counts.get(label, 0) + n

    def _live(self, now: float) -> Iterator[dict[str, int]]:
        newest = self._index(now)
        oldest = newest - self.slots + 1
        for slot in range(self.slots):
            epoch = self._epoch[slot]
            if epoch is not None and oldest <= epoch <= newest:
                yield self._counts[slot]

    def tally(self, now: float) -> dict[str, int]:
        merged: dict[str, int] = {}
        for counts in self._live(now):
            for label, n in counts.items():
                merged[label] = merged.get(label, 0) + n
        return merged

    def total(self, now: float) -> int:
        return sum(sum(counts.values()) for counts in self._live(now))

    def top(self, now: float, k: int) -> list[tuple[str, int]]:
        """Highest-count labels first, ties broken by label so the rail does not
        reshuffle two equal countries every poll."""
        items = self.tally(now).items()
        return sorted(items, key=lambda kv: (-kv[1], kv[0]))[:k]


def foreign_country(ev: Event) -> Optional[str]:
    """The placeable non-home end of an event, or None.

    Deliberately the same rule as `foreignEnd()` in the renderer's classify.js:
    prefer the destination, fall back to the source, and treat `--` as not a
    country. Every geo policy on an outbound-blocking router puts the blocked
    country in the destination while the source is a LAN address, so reading
    src_country alone would file every block under `--` and the rail's top-5
    would be one row reading "-- 812".
    """
    for cc in (ev.dst_country, ev.src_country):
        if isinstance(cc, str) and len(cc) == 2 and cc != "--":
            return cc
    return None


# One bucket per 15 minutes over a day, and one per second over a minute.
BLOCK_WINDOW, BLOCK_SLOTS = 86400.0, 96
FLOW_WINDOW, FLOW_SLOTS = 60.0, 60


class Stats:
    """What /stats.json serves. Fed from main.on_event.

    `decoder`, `syslog` and `enricher` are attached after construction because
    they only exist on the live path -- synthetic mode has no IPFIX decoder and
    no GeoIP database, and the rail must degrade to "no data" for those rows
    rather than the collector failing to start without them.
    """

    def __init__(self, clock=time.time) -> None:
        self._clock = clock
        self.blocks = RollingCounter(BLOCK_WINDOW, BLOCK_SLOTS)
        self.flows = RollingCounter(FLOW_WINDOW, FLOW_SLOTS)
        self.decoder: Any = None
        self.syslog: Any = None
        self.enricher: Any = None
        self.started = clock()
        # Age of the newest event when it reached us: router export interval
        # plus network plus queueing. Last value, not an average -- the rail is
        # answering "is this live right now".
        self.lag: Optional[float] = None
        self.blocks_unplaced = 0

    def note(self, ev: Event, now: Optional[float] = None) -> None:
        now = self._clock() if now is None else now
        if ev.kind == "block":
            cc = foreign_country(ev)
            if cc is None:
                # A block whose far end GeoIP could not place. Counted so the
                # rail's total matches the number of block arcs the globe drew,
                # instead of quietly under-reporting by the unplaceable ones.
                self.blocks_unplaced += 1
            else:
                self.blocks.add(cc, now)
        else:
            self.flows.add("flow", now)
        if ev.ts:
            # Clamped at 0: a router whose clock runs ahead would otherwise show
            # a negative lag, which reads as a bug rather than as clock skew.
            self.lag = max(0.0, now - ev.ts)

    def snapshot(self, now: Optional[float] = None) -> dict:
        now = self._clock() if now is None else now
        placed = self.blocks.total(now)
        return {
            "now": now,
            "uptime": now - self.started,
            "blocks": {
                "window_seconds": BLOCK_WINDOW,
                "total": placed + self.blocks_unplaced,
                "unplaced": self.blocks_unplaced,
                "top": [{"cc": cc, "n": n} for cc, n in self.blocks.top(now, 5)],
            },
            "netflow": {
                "flows_per_min": self.flows.total(now),
                "lag_seconds": self.lag,
                "ipfix": dict(self.decoder.stats) if self.decoder is not None else None,
                "syslog": dict(self.syslog.stats) if self.syslog is not None else None,
            },
            # The miss rate is not comparable between the two supported
            # databases -- GeoLite2 reports no location for anycast ranges and
            # DB-IP City Lite always answers -- so the number travels with the
            # name of the database that produced it.
            "geoip": {
                "miss_rate": (self.enricher.miss_rate()
                              if self.enricher is not None else None),
                "database": getattr(self.enricher, "database_type", None),
            },
        }
