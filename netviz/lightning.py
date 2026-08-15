"""Real lightning, replayed at 1x about forty minutes behind the world.

Blitzortung's volunteer network publishes every located stroke on Earth as a
free, keyless archive of 10-minute buckets:

    https://data.lightningmaps.org/Public/Strokes/World/YYYYMMDD_HHM0.json.gz

Measured live on 2026-08-15: the 06:50 bucket held 6,901 strokes -- 11.5 per
second worldwide -- at 1-second resolution across all 600 seconds, and appeared
on the server at 07:21, bucket start plus 31 minutes. A stroke is therefore
36-46 minutes old before the wall can draw it.

THAT DELAY IS THE DESIGN, not a defect worked around. A bucket covers 600
seconds and the next arrives 600 seconds later, so playing each bucket back at
1x as it lands consumes buckets exactly as fast as they are published: the wall
sits a constant ~40 minutes behind with no drift, no gaps and no queue. Storm
cells pulse and drift as they really did. The rail says how far behind, because
a viewer who reads these as current strikes has been misled by the display.

THE FILE IS NOT JSON, and this is the trap that will look like a bug:

    {"time":2026-08-15T06:50:00,"lat":35.544954,"lon":-73.302341,"src":2,"srv":1},

The timestamp is unquoted, every line ends in a comma, and there is no array
wrapper. `json.loads` fails on the file and on any single line of it, so the
parser is a per-line regex -- which has the second benefit that a field added
upstream cannot break it. `tests/test_lightning.py::test_the_feed_is_not_json`
exists to stop somebody 'cleaning this up' back into the json module.

`src` and `srv` were constant across all 6,901 records and carry nothing the
display can use. Dropped.
"""
import calendar
import gzip
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Optional

log = logging.getLogger("netviz")

URL_BASE = "https://data.lightningmaps.org/Public/Strokes/World"

# A bucket covers ten minutes.
BUCKET_SECONDS = 600

# Observed publish delay is bucket start + 31 minutes, twice. One minute of
# margin, because asking for a bucket that does not exist yet costs a wasted
# poll and a 404 in the log.
PUBLISH_LAG = 32 * 60

# The measured bucket was 6,901 strokes and a convective season runs higher.
MAX_STROKES = 6000

# Deliberately tolerant: anything between the fields is skipped, so an added
# key upstream changes nothing here. The timestamp is matched as digits rather
# than parsed as JSON because it is not quoted and never will be.
_LINE = re.compile(
    r'"time"\s*:\s*\d{4}-\d{2}-\d{2}T\d{2}:(\d{2}):(\d{2})'
    r'.*?"lat"\s*:\s*(-?\d+(?:\.\d+)?)'
    r'.*?"lon"\s*:\s*(-?\d+(?:\.\d+)?)'
)


def bucket_name(t: float) -> str:
    """Epoch seconds -> the name of the bucket containing them."""
    floored = int(t) - (int(t) % BUCKET_SECONDS)
    return time.strftime("%Y%m%d_%H%M", time.gmtime(floored))


def bucket_start(name: str) -> float:
    """The inverse of bucket_name, for age arithmetic."""
    return float(calendar.timegm(time.strptime(name, "%Y%m%d_%H%M")))


def latest_ready(now: float, lag: float = PUBLISH_LAG) -> str:
    """The newest bucket whose publish deadline has already passed."""
    return bucket_name(now - lag)


def parse(text: str) -> tuple[list[tuple[int, float, float]], int]:
    """Decompressed body -> (strokes sorted by second, lines skipped).

    A line that does not match is counted, never raised on -- the same argument
    as the syslog parser's `unparsed` counter. A feed that changes shape must
    degrade to fewer strokes, never to no collector.
    """
    strokes: list[tuple[int, float, float]] = []
    skipped = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        m = _LINE.search(line)
        if not m:
            skipped += 1
            continue
        minute, second, lat, lon = m.groups()
        # The second WITHIN the bucket, which is all playback needs and is
        # derivable from the timestamp alone: a bucket starts on a multiple of
        # ten minutes, so minute % 10 is the offset into it.
        at = (int(minute) % 10) * 60 + int(second)
        strokes.append((at, float(lat), float(lon)))
    strokes.sort(key=lambda s: s[0])
    return strokes, skipped


def sample(strokes: list, cap: int = MAX_STROKES) -> list:
    """Thin to `cap`, evenly across the bucket's 600 seconds.

    Not truncation and not a random draw. Truncating replays the first N
    seconds and then goes dark; a random draw visibly clumps. Taking an even
    stride drops density per storm uniformly, which is the only lossy answer
    that leaves the pacing honest.
    """
    n = len(strokes)
    if cap <= 0 or n <= cap:
        return list(strokes)
    if cap == 1:
        return [strokes[0]]
    # (n - 1) / (cap - 1) rather than n / cap so the first and last stroke are
    # both kept: a bucket that visibly starts late or ends early would read as
    # a gap in the weather.
    return [strokes[round(i * (n - 1) / (cap - 1))] for i in range(cap)]


def fetch(name: str, timeout: float = 30.0) -> Optional[list]:
    """One bucket, downloaded and parsed. None on any failure. Never raises.

    Blocking urllib and a blocking gunzip, so the caller runs it in a thread:
    a slow volunteer server must not stall the event loop any more than a slow
    NOAA may.
    """
    url = f"{URL_BASE}/{name}.json.gz"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "netviz"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
    except (urllib.error.URLError, OSError, ValueError) as err:
        log.warning("lightning: fetch %s failed: %s", name, err)
        return None
    try:
        text = gzip.decompress(body).decode("utf-8", "replace")
    except (OSError, EOFError) as err:
        log.warning("lightning: %s is not readable gzip: %s", name, err)
        return None
    strokes, skipped = parse(text)
    if not strokes:
        log.warning("lightning: %s parsed to nothing (%d lines skipped)", name, skipped)
        return None
    if skipped:
        log.info("lightning: %s skipped %d unparsable lines", name, skipped)
    return strokes


class LightningCache:
    """One bucket, in memory.

    In memory rather than on disk, which is the opposite of CloudCache and for
    the opposite reason: a cloud field recovered across a restart is still the
    current weather, while a lightning bucket recovered across a restart is
    already expired. There is nothing worth keeping.
    """

    def __init__(self, cap: int = MAX_STROKES) -> None:
        self._cap = cap
        self._name: Optional[str] = None
        self._start: Optional[float] = None
        self._strokes: list = []

    @property
    def name(self) -> Optional[str]:
        return self._name

    def update(self, name: str, strokes: list) -> None:
        kept = sample(strokes, self._cap)
        # Rounded once here rather than on every request: 3 decimals is 110 m,
        # far below one pixel of a globe on a wall, and it takes the payload
        # from ~125 KB to ~95 KB.
        self._strokes = [[int(s), round(lat, 3), round(lon, 3)] for s, lat, lon in kept]
        self._name = name
        self._start = bucket_start(name)

    def state(self, now: float) -> dict:
        """What /lightning.json serves.

        `bucket` is null before the first successful fetch -- not absent, and
        not a bucket recovered from disk. The renderer has to be able to tell
        'nothing fetched yet' from 'a quiet sky', and unlike clouds, a quiet
        sky is a real and common state.
        """
        return {
            "bucket": (None if self._start is None
                       else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._start))),
            "age": None if self._start is None else now - self._start,
            "count": len(self._strokes),
            "window": BUCKET_SECONDS,
            "strokes": self._strokes,
        }


def next_poll_delay(now: float, period: float = float(BUCKET_SECONDS),
                    offset: float = float(PUBLISH_LAG)) -> float:
    """Seconds until just after the next publication. Never 0 -- see aurora.

    Polling every 600s from an arbitrary start sits up to a full period behind
    the data; aligning to the boundary plus the publish lag asks once, just
    after there is something new to ask for.
    """
    since = (now - offset) % period
    delay = period - since
    return delay if delay > 1.0 else period


def refresh(cache: LightningCache, now: Optional[float] = None,
            fetcher=fetch) -> bool:
    """One poll cycle. Never raises; returns whether the cache moved."""
    now = time.time() if now is None else now
    name = latest_ready(now)
    if name == cache.name:
        return False
    strokes = fetcher(name)
    if not strokes:
        return False
    cache.update(name, strokes)
    log.info("lightning: playing %s (%d strokes)", name, len(strokes))
    return True
