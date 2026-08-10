"""Live geomagnetic activity, so the aurora on the globe is the real one.

NOAA SWPC publishes the planetary K-index on 3-hour boundaries, free and
without a key. The collector polls once per publication and serves the current
value to the kiosk at /aurora.json; the renderer turns Kp into the size of the
auroral oval.

Kp is what actually decides whether there is an aurora and how far south it
reaches, so drawing a fixed ring would be decoration. This is the difference
between "there is an aurora tonight" and "there is always an aurora".
"""
import json
import logging
import urllib.error
import urllib.request
from typing import Optional

log = logging.getLogger("netviz")

URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"

# How long a fetched value stays trustworthy. It MUST exceed the 3-hour publish
# cadence: at the old 1 hour, every reading went stale two hours before its
# replacement existed and the aurora sat permanently at the 40% dimmed
# strength. Four hours means one missed publication is tolerated and two is
# not, which is the actual failure worth flagging.
DEFAULT_TTL = 4 * 3600.0


def fetch_kp(url: str = URL, timeout: float = 15.0) -> Optional[float]:
    """Most recent planetary Kp, or None.

    Never raises. The globe has to keep drawing when NOAA is unreachable, so
    every failure mode -- network, HTML error page, changed feed shape -- comes
    back as None and the cache decides what to do about it.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            rows = json.loads(r.read())
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
        log.warning("aurora: could not fetch Kp: %s", err)
        return None

    if not isinstance(rows, list) or not rows:
        log.warning("aurora: unexpected feed shape")
        return None

    # SWPC serves this endpoint as a list of OBJECTS ({"time_tag", "Kp", ...}),
    # verified against the live feed. Sibling endpoints use the header-row +
    # arrays form, so both are accepted rather than guessing which one a future
    # URL change lands on.
    if isinstance(rows[0], dict):
        candidates = [r.get("Kp") for r in rows if isinstance(r, dict)]
    else:
        if len(rows) < 2:
            log.warning("aurora: header-only feed")
            return None
        candidates = [r[1] if len(r) > 1 else None for r in rows[1:]]

    # Newest last. Walk backwards to the last usable value: the final row is
    # occasionally still null while the period is being built.
    for raw in reversed(candidates):
        try:
            kp = float(raw)
        except (TypeError, ValueError):
            continue
        if 0.0 <= kp <= 9.0:
            return kp
        log.warning("aurora: Kp out of range: %r", raw)
        return None
    return None


class KpCache:
    """Last good Kp plus how old it is.

    Separate from the fetch so a failed refresh keeps showing the last real
    value rather than dropping the aurora to nothing -- but flags it stale, so
    the renderer can stop pretending it knows.
    """

    def __init__(self, ttl: float = DEFAULT_TTL) -> None:
        self._ttl = ttl
        self._kp: Optional[float] = None
        self._at: Optional[float] = None

    def update(self, kp: Optional[float], now: float) -> None:
        if kp is None:
            return                      # keep the previous value and let it age
        self._kp = kp
        self._at = now

    def state(self, now: float) -> dict:
        age = None if self._at is None else now - self._at
        return {
            "kp": self._kp,
            "age": age,
            # No value yet is stale, not quiet: Kp 0 is a real, very calm sky
            # and must not be confused with "we have never reached NOAA".
            # >= not >: a value exactly at the ttl has expired. Same boundary
            # rule the replay window uses.
            "stale": age is None or age >= self._ttl,
        }


# NOAA publishes planetary Kp on 3-hour boundaries (00, 03, 06 ... UTC), which
# is the real cadence of the data. Polling faster only asks someone else's free
# service the same question repeatedly.
POLL_PERIOD = 3 * 3600.0
# ...but polling every 3 hours from an arbitrary start would sit up to a full
# period behind. Firing a few minutes after each boundary keeps the wall within
# minutes of the publication instead.
POLL_OFFSET = 240.0


def next_poll_delay(now: float, period: float = POLL_PERIOD,
                    offset: float = POLL_OFFSET) -> float:
    """Seconds until just after the next publish boundary.

    Never returns 0: a zero delay would spin the poller into a hot loop.
    """
    since = (now - offset) % period
    delay = period - since
    return delay if delay > 1.0 else period


def oval_boundary(kp: float) -> float:
    """Equatorward edge of the auroral oval, in degrees of geomagnetic latitude.

    The usual rule of thumb: about 66 degrees when quiet, moving roughly 2
    degrees equatorward per Kp step. Matches the published viewing-latitude
    tables closely enough for a wall display -- Kp 7 lands near 55, which is
    the "visible from northern England" case.
    """
    return 66.5 - 1.7 * max(0.0, min(9.0, kp))
