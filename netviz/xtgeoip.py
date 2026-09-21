"""The router's own geo-IP tables, so a block arc lands where the router
thought it was going.

The router blocks with iptables `-m geoip`, which resolves against xt_geoip.
The globe geolocates with MaxMind. They disagree about real addresses, so a
block could draw in a country that is not on the block list at all -- which
reads as a bug in the display when the router was right by its own data.

This module answers only one question, and only for blocks: *which watched
country did the thing that made this decision believe this address was in*.
Everything else on the display stays on MaxMind, which is the better database
for the question it is being asked (where in the world is this host, roughly).

Pure and offline: it reads whatever is in the configured directory and never
reaches for a network, a router or a credential. **Nothing in this project puts
those files there**, deliberately -- the collector's whole relationship with the
router is that the router pushes IPFIX and syslog to it, and a tool that had to
log in to copy 42 files would have been the only reason this project ever asked
anyone for router credentials. Copy them by whatever means the site already
uses; the format below is the whole contract, and the directory being empty or
absent is a supported, ordinary state.

File format, verified against a live UDM SE: one file per country per family,
in `/usr/share/xt_geoip/LE`. `.iv4` is pairs of little-endian uint32
(start, end), inclusive.

`.iv6` is pairs of 16-byte addresses stored as **four little-endian uint32
words**, not as raw in6_addr bytes -- the LE in the directory name applies to
them too. This is worth stating because the wrong reading does not look wrong:
decoding China's first range as big-endian bytes yields `5002:120::`, which is
a syntactically perfect IPv6 address, sorts fine, and simply never matches
anything. Read as LE words the same bytes are `2001:250::/36`, which is CERNET.
The check that catches it is whether the decoded prefixes are plausible global
unicast (`2000::/3`), not whether they parse.
"""
import ipaddress
import logging
import os
import struct
from bisect import bisect_right
from typing import Optional

log = logging.getLogger("netviz")


def _has_tables(directory: str) -> bool:
    """Does this directory hold at least one `CC.iv4`/`CC.iv6` table?"""
    try:
        names = os.listdir(directory)
    except OSError:
        return False
    for name in names:
        stem, _, ext = name.partition(".")
        if ext in ("iv4", "iv6") and len(stem) == 2:
            return True
    return False


class XtGeoIP:
    """Watched-country ranges, searched by bisection.

    Ranges are held as one sorted list of starts per family plus a parallel
    list of (end, country), so a lookup is a bisection over ~100k entries
    rather than a scan of 21 countries' worth of ranges. Building it costs one
    sort of the whole set at startup; the alternative -- a per-country lookup
    in a loop -- is 21 bisections per block event, forever.
    """

    def __init__(self) -> None:
        self._v4_starts: list[int] = []
        self._v4_ends: list[tuple[int, str]] = []
        self._v6_starts: list[int] = []
        self._v6_ends: list[tuple[int, str]] = []
        self.countries: list[str] = []
        self.ranges = 0

    @classmethod
    def load(cls, directory: str) -> Optional["XtGeoIP"]:
        """Every `CC.iv4`/`CC.iv6` in `directory`, or None if there are none.

        None rather than an empty instance: "no tables installed" is the
        ordinary case for anyone who has not run the fetch script, and the
        caller should skip the whole code path rather than consult a resolver
        that can only ever answer "not found" -- which is indistinguishable
        from "this address is genuinely not in a watched country" and would
        silently do nothing while looking like it worked.
        """
        if not os.path.isdir(directory):
            return None

        # The router keeps its tables one level down, in an endianness
        # directory (`.../xt_geoip/LE/CN.iv4`). A hand copy that preserves
        # that layout -- the obvious way to copy them -- puts CC.iv4 in
        # `directory/LE`, where a non-recursive scan finds nothing and
        # returns the same None as "never installed". Look there too. LE
        # only: the records are little-endian and `_parse` assumes it, so a
        # BE directory would decode to plausible nonsense rather than fail.
        if not _has_tables(directory) and _has_tables(os.path.join(directory, "LE")):
            log.info("xt_geoip: no tables in %s, using its LE/ subdirectory",
                     directory)
            directory = os.path.join(directory, "LE")

        v4: list[tuple[int, int, str]] = []
        v6: list[tuple[int, int, str]] = []
        codes: set[str] = set()
        for name in sorted(os.listdir(directory)):
            stem, _, ext = name.partition(".")
            if ext not in ("iv4", "iv6") or len(stem) != 2:
                continue
            path = os.path.join(directory, name)
            try:
                blob = open(path, "rb").read()
            except OSError as e:
                log.warning("xt_geoip: cannot read %s: %s", path, e)
                continue
            cc = stem.upper()
            if ext == "iv4":
                if len(blob) % 8:
                    log.warning("xt_geoip: %s is not a whole number of "
                                "8-byte records, skipped", name)
                    continue
                for lo, hi in struct.iter_unpack("<II", blob):
                    v4.append((lo, hi, cc))
            else:
                if len(blob) % 32:
                    log.warning("xt_geoip: %s is not a whole number of "
                                "32-byte records, skipped", name)
                    continue
                for words in struct.iter_unpack("<8I", blob):
                    lo = int.from_bytes(struct.pack(">4I", *words[:4]), "big")
                    hi = int.from_bytes(struct.pack(">4I", *words[4:]), "big")
                    v6.append((lo, hi, cc))
            codes.add(cc)

        if not v4 and not v6:
            return None

        self = cls()
        self.countries = sorted(codes)
        self.ranges = len(v4) + len(v6)
        v4.sort()
        v6.sort()
        self._v4_starts = [lo for lo, _, _ in v4]
        self._v4_ends = [(hi, cc) for _, hi, cc in v4]
        self._v6_starts = [lo for lo, _, _ in v6]
        self._v6_ends = [(hi, cc) for _, hi, cc in v6]
        log.info("xt_geoip: loaded %d ranges for %d countries from %s",
                 self.ranges, len(self.countries), directory)
        return self

    def lookup(self, ip: str) -> Optional[str]:
        """The watched country holding `ip`, or None.

        None covers three cases the caller treats identically: a malformed
        address, an address in no watched country, and an address the router's
        tables place somewhere it does not block.
        """
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        if isinstance(addr, ipaddress.IPv4Address):
            starts, ends = self._v4_starts, self._v4_ends
        else:
            starts, ends = self._v6_starts, self._v6_ends
        n = int(addr)
        # The last range that starts at or before the address. Ranges within
        # one country do not overlap, and two countries cannot both claim an
        # address in a table built from a single allocation list, so checking
        # that one candidate's end is enough.
        i = bisect_right(starts, n) - 1
        if i < 0:
            return None
        end, cc = ends[i]
        return cc if n <= end else None
