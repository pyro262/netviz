"""Live cloud cover, so the weather on the globe is the real weather.

NOAA's Global Mosaic of Geostationary Satellite Imagery (GMGSI) blends the
longwave infrared channel of every geostationary weather satellite in orbit --
GOES-18 and -19, Meteosat-9 and -10, Himawari-9 -- into one global field, hourly,
free and without a key, on AWS Open Data. The collector fetches the newest
granule, turns it into a greyscale PNG and serves it at /clouds.png; the
renderer wraps it around the globe as an alpha mask.

Same discipline as aurora.py: NO GRANULE MEANS NO CLOUDS. A cloud field that is
silently nine hours old is a lie the wall cannot correct, so the age rides
/clouds.json and the renderer fades the layer out rather than pretending.

TWO THINGS ABOUT THE DATA THAT ARE NOT OBVIOUS, both measured against the live
20:00Z granule on 2026-08-14:

  * The grid is plain equirectangular at 0.0722 degrees -- 4999 x 3000, lon
    -179.928..180 -- so it maps to the sphere with no reprojection at all.
    But it stops at +/-72.7 degrees of latitude, because a geostationary
    satellite cannot see the poles. The renderer fades the layer out there;
    stretching the last row to the pole would invent weather.
  * `data` is documented as "0-255 Brightness Temperature" with units K, which
    is two things at once and neither of them exactly. It is already scaled to
    0-255 with cloud BRIGHT and clear sky dark, which is what an alpha mask
    wants, so it is used as-is rather than converted back to kelvin.

`dqf` is read because it is the difference between a globe and a globe with a
solid white slab across it: the raw granule carries blocks of flagged pixels at
maximum value, which as an alpha mask is an opaque rectangle of "cloud".
"""
import logging
import os
import re
import struct
import time
import urllib.error
import urllib.request
import zlib
from typing import Optional

log = logging.getLogger("netviz")

BUCKET = "https://noaa-gmgsi-pds.s3.amazonaws.com"
# The longwave IR mosaic. LW rather than the shortwave or visible products
# because it works at night: a cloud layer that only exists on the day side
# would follow the terminator around the wall like a bug.
PRODUCT = "GMGSI_LW"

# How long a fetched field stays trustworthy, mirroring KpCache's rule that the
# ttl must exceed the publish cadence. Three hours tolerates two missed
# publications; beyond that the weather on screen is old enough to be wrong
# about where a storm is.
DEFAULT_TTL = 3 * 3600.0

# The granule is 4999x3000. Halving twice gives 1249x750, which is a sane
# texture for a wall and about 700 KB of PNG; the kiosk re-fetches it hourly.
DEFAULT_FACTOR = 4


def hour_prefixes(now: float, back: int = 4) -> list[str]:
    """Bucket prefixes for this hour and the ones before it, newest first.

    The newest hour frequently does not exist yet -- the 20:00Z granule was
    written at 20:34Z -- and around midnight the previous hours belong to
    yesterday's date path, which is the case a naive "same day" implementation
    gets wrong once per night.
    """
    out = []
    for i in range(max(1, back)):
        t = time.gmtime(now - i * 3600.0)
        out.append(f"{PRODUCT}/{t.tm_year:04d}/{t.tm_mon:02d}/{t.tm_mday:02d}/{t.tm_hour:02d}/")
    return out


_KEY = re.compile(r"<Key>([^<]{1,512})</Key>")


def parse_listing(body: str) -> list[str]:
    """Every <Key> in an S3 v2 listing. Never raises.

    A regex rather than an XML parser, deliberately. This body is a remote,
    untrusted document, and the stdlib parsers resolve entities -- billion
    laughs and XXE are real against them -- so using one here would mean taking
    `defusedxml` as a fourth runtime dependency to read two tags. The shape is
    fixed by the S3 API and the only thing wanted from it is the key list.

    An error document, an HTML captive portal and an empty body are all "no
    keys": the globe has to keep drawing when the bucket is unreachable.
    """
    return _KEY.findall(body or "")


_STAMP = re.compile(r"_s(\d{14})")


def granule_time(key: str) -> Optional[float]:
    """The granule's coverage start, from the `_sYYYYMMDDhhmmss` in its name."""
    m = _STAMP.search(key or "")
    if not m:
        return None
    try:
        t = time.strptime(m.group(1)[:14], "%Y%m%d%H%M%S")
    except ValueError:
        return None
    import calendar
    return float(calendar.timegm(t))


def newest_key(keys) -> Optional[str]:
    """The latest granule by its own start stamp, not by string order.

    Lexical order happens to agree while the filename prefix is constant, which
    is exactly the kind of accident that breaks silently at a version bump
    (v3r0 -> v4r0 sorts before its own successor).
    """
    dated = [(granule_time(k), k) for k in (keys or [])]
    dated = [(t, k) for t, k in dated if t is not None]
    if not dated:
        return None
    return max(dated)[1]


def _get(url: str, timeout: float):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def find_latest(now: float, back: int = 4, timeout: float = 20.0) -> Optional[str]:
    """Key of the newest published granule, or None. Never raises."""
    for prefix in hour_prefixes(now, back):
        url = f"{BUCKET}/?list-type=2&prefix={prefix}&max-keys=64"
        try:
            body = _get(url, timeout).decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            log.warning("clouds: listing %s failed: %s", prefix, err)
            continue
        key = newest_key(parse_listing(body))
        if key:
            return key
    log.warning("clouds: no granule in the last %d hours", back)
    return None


def download(key: str, path: str, timeout: float = 120.0) -> bool:
    """Fetch a granule to disk. Never raises; False means no file was written.

    Streamed to a file rather than held in memory: the granule is 7.2 MB and
    h5py wants a file anyway.
    """
    tmp = f"{path}.tmp"
    try:
        with urllib.request.urlopen(f"{BUCKET}/{key}", timeout=timeout) as r:
            with open(tmp, "wb") as out:
                while chunk := r.read(1 << 20):
                    out.write(chunk)
        os.replace(tmp, path)
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        log.warning("clouds: download failed: %s", err)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def downsample(a, factor: int):
    """Mean of each factor x factor block, dropping any ragged edge.

    A block mean rather than nearest-neighbour: cloud edges are the whole
    subject, and point sampling turns a frontal band into stipple. The ragged
    edge is dropped rather than padded -- 4999 is odd, and averaging a real
    column with an invented one puts a seam down the antimeridian.
    """
    import numpy as np
    if factor <= 1:
        return a
    h = (a.shape[0] // factor) * factor
    w = (a.shape[1] // factor) * factor
    block = a[:h, :w].reshape(h // factor, factor, w // factor, factor)
    return block.mean(axis=(1, 3)).astype(np.uint8)


def write_png(a) -> bytes:
    """An 8-bit greyscale PNG, with stdlib zlib and no image library.

    Pillow would do this in a line, but it is a third runtime dependency for
    one call, on a container that ships three. The format is trivial at this
    bit depth: no palette, no filtering (every scanline is prefixed with a 0
    filter byte), one IDAT.
    """
    h, w = a.shape
    raw = bytearray()
    data = a.tobytes()
    for y in range(h):
        raw.append(0)
        raw += data[y * w:(y + 1) * w]

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def granule_to_png(path: str, factor: int = DEFAULT_FACTOR):
    """(png_bytes, coverage_start) for a granule on disk, or None.

    Never raises: a truncated download, a changed variable name and a file that
    is not HDF5 at all must all cost the cloud layer and nothing else.
    """
    try:
        import h5py
        import numpy as np
    except ImportError as err:                       # pragma: no cover
        log.warning("clouds: %s -- cloud layer disabled", err)
        return None
    try:
        with h5py.File(path, "r") as f:
            data = np.asarray(f["data"][0], dtype="float32")
            dqf = np.asarray(f["dqf"][0]) if "dqf" in f else None
            raw = f.attrs.get("time_coverage_start")
    except (OSError, KeyError, IndexError, ValueError) as err:
        log.warning("clouds: cannot read granule: %s", err)
        return None

    # Fill values are -9999; flagged pixels are whatever the blend last had
    # there, often maximum. Both become clear sky rather than cloud.
    bad = ~np.isfinite(data) | (data < 0)
    if dqf is not None and dqf.shape == data.shape:
        bad |= (dqf != 0)
    data = np.where(bad, 0.0, data)
    out = downsample(np.clip(data, 0, 255).astype("uint8"), factor)

    valid = None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        try:
            import calendar
            valid = float(calendar.timegm(time.strptime(raw, "%Y-%m-%dT%H:%M:%SZ")))
        except ValueError:
            valid = None
    return write_png(out), valid


class CloudCache:
    """The current cloud PNG on disk, plus how old the weather in it is.

    On disk rather than in memory for the same reason the IPFIX templates are:
    a collector restart must not re-download 7 MB and leave the wall bare until
    it lands. The file's mtime carries the coverage time across that restart,
    so the age it reports is the weather's age and not the process's.
    """

    def __init__(self, path: str, ttl: float = DEFAULT_TTL) -> None:
        self._path = path
        self._ttl = ttl
        self._valid: Optional[float] = None
        try:
            self._valid = os.path.getmtime(path)
        except OSError:
            self._valid = None

    def update(self, png: Optional[bytes], valid: Optional[float],
               now: Optional[float] = None) -> None:
        """Install a new field. None keeps the previous one and lets it age."""
        if png is None:
            return
        tmp = f"{self._path}.tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(png)
            os.replace(tmp, self._path)
        except OSError as err:
            # A read-only /state costs the clouds, never the collector.
            log.warning("clouds: cannot write %s: %s", self._path, err)
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return
        self._valid = valid if valid is not None else (now if now is not None else time.time())
        try:
            os.utime(self._path, (self._valid, self._valid))
        except OSError:
            pass

    def read(self) -> Optional[bytes]:
        try:
            with open(self._path, "rb") as f:
                return f.read()
        except OSError:
            return None

    def state(self, now: float) -> dict:
        age = None if self._valid is None else now - self._valid
        return {
            "valid": self._valid,
            "age": age,
            # Never fetched is stale, not clear: "no clouds anywhere on Earth"
            # is not a thing, and the renderer must be able to tell the two
            # apart. Same >= boundary as KpCache.
            "stale": age is None or age >= self._ttl,
            "ttl": self._ttl,
        }


# GMGSI publishes hourly, and the granule for an hour appears roughly half an
# hour after it. Polling on the hour asks for a file that does not exist yet;
# the offset is what makes the request worth making.
POLL_PERIOD = 3600.0
POLL_OFFSET = 45 * 60.0


def next_poll_delay(now: float, period: float = POLL_PERIOD,
                    offset: float = POLL_OFFSET) -> float:
    """Seconds until just after the next publication. Never 0 -- see aurora."""
    since = (now - offset) % period
    delay = period - since
    return delay if delay > 1.0 else period


def refresh(cache: CloudCache, work_dir: str, now: Optional[float] = None) -> bool:
    """One fetch cycle: find, download, convert, install. Never raises."""
    now = time.time() if now is None else now
    key = find_latest(now)
    if not key:
        return False
    at = granule_time(key)
    current = cache.state(now)["valid"]
    if at is not None and current is not None and at <= current:
        return False                    # already have this hour
    tmp = os.path.join(work_dir, "granule.nc")
    if not download(key, tmp):
        return False
    try:
        made = granule_to_png(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not made:
        return False
    png, valid = made
    cache.update(png, valid if valid is not None else at, now)
    log.info("clouds: installed %s (%d KB)", os.path.basename(key), len(png) // 1024)
    return True
