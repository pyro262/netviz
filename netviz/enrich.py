"""IP to coordinates. Pure over a memory-mapped MaxMind-format database — no
network I/O, so this is the easiest unit in the collector to test."""
import ipaddress
import logging
import os
from typing import Literal, Optional

from .events import Event

log = logging.getLogger("netviz")

PRIVATE_COUNTRY = "--"

# Tried in order, in the same directory as the configured database, when the
# configured path is not there. Both are MaxMind-format .mmdb files and geoip2
# reads either, so the only difference is which one a given install obtained.
#
# GeoLite2 first because it is the better database where someone has bothered
# to make an account: it has no record for anycast ranges and says so, where
# DB-IP answers with a confident registrant-country guess. DB-IP City Lite
# needs no account at all (tools/fetch_dbip.sh), which is the whole point of
# having it here -- a fresh clone with no credentials still geolocates traffic,
# instead of failing to start and drawing nothing.
FALLBACK_NAMES = ("GeoLite2-City.mmdb", "dbip-city-lite.mmdb")


def resolve_mmdb(configured: str) -> str:
    """The database this run should open.

    Returns `configured` untouched when it exists -- an explicit NETVIZ_MMDB is
    always honoured if it points at a real file. Otherwise the siblings in
    FALLBACK_NAMES are tried, loudly, so "which database am I actually running
    on" is answerable from the log rather than by guessing. Returns
    `configured` when nothing is found, so the caller still raises the same
    error naming the path the operator asked for.
    """
    if os.path.exists(configured):
        return configured

    # Kept bare rather than "./name" when the configured path has no directory
    # part, so the log names the file the way the operator would type it.
    directory = os.path.dirname(configured)
    for name in FALLBACK_NAMES:
        candidate = os.path.join(directory, name) if directory else name
        if candidate != configured and os.path.exists(candidate):
            log.warning("geoip: %s not found, using %s instead",
                        configured, candidate)
            return candidate

    log.error("geoip: no database at %s and no fallback in %s (looked for %s). "
              "Run tools/fetch_dbip.sh for the no-account DB-IP City Lite "
              "build, or tools/refresh_geoip.sh with MaxMind credentials.",
              configured, directory or ".", ", ".join(FALLBACK_NAMES))
    return configured


class Enricher:
    def __init__(self, mmdb_path: str, home: tuple[float, float]) -> None:
        import geoip2.database
        self.mmdb_path = resolve_mmdb(mmdb_path)
        self._reader = geoip2.database.Reader(self.mmdb_path)
        # Which database this is, for the status log and /stats.json: the two
        # supported builds disagree about anycast addresses, so a miss rate is
        # not comparable between them and the number needs its source attached.
        self.database_type = self._reader.metadata().database_type
        log.info("geoip: opened %s (%s)", self.mmdb_path, self.database_type)
        self._home = home
        self.stats = {"hits": 0, "misses": 0, "private": 0, "errors": 0}

    def close(self) -> None:
        self._reader.close()

    def miss_rate(self) -> float:
        attempts = self.stats["hits"] + self.stats["misses"]
        return self.stats["misses"] / attempts if attempts else 0.0

    def _locate(self, ip: str) -> tuple[Optional[tuple[float, float, str]], Literal["hit", "miss", "error", "private"]]:
        """Locate an IP address. Returns (coordinates, status).

        Status can be:
        - "hit": coordinates found in database
        - "miss": IP not in database (genuine not-found)
        - "error": operational fault (corrupt db, permissions, etc.)
        - "private": private/loopback/link-local address (mapped to home)
        """
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return (None, "miss")
        # Check for loopback and link-local (always private)
        if addr.is_loopback or addr.is_link_local:
            return (self._home[0], self._home[1], PRIVATE_COUNTRY), "private"
        # Check for RFC 1918 ranges explicitly instead of using ipaddress.is_private.
        # Python 3.10+ expanded is_private to include TEST-NET documentation ranges
        # (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), which real
        # telemetry uses as ordinary public IPs for testing and must be geolocatable.
        if isinstance(addr, ipaddress.IPv4Address):
            if addr in ipaddress.ip_network("10.0.0.0/8") or \
               addr in ipaddress.ip_network("172.16.0.0/12") or \
               addr in ipaddress.ip_network("192.168.0.0/16"):
                return (self._home[0], self._home[1], PRIVATE_COUNTRY), "private"
        elif isinstance(addr, ipaddress.IPv6Address):
            if addr.is_private:  # For IPv6, is_private is more reasonable
                return (self._home[0], self._home[1], PRIVATE_COUNTRY), "private"
        try:
            r = self._reader.city(ip)
        except Exception as e:
            # Distinguish between "IP not in database" (miss) and operational faults (error).
            # Only ValueError (malformed IP) and geoip2 not-found errors count as misses.
            # Operational faults (corrupt db, permissions, library bugs) increment errors.
            try:
                import geoip2.errors
                not_found_class = geoip2.errors.AddressNotFoundError
            except ImportError:
                # geoip2 not available; fall back to treating only KeyError as not-found
                not_found_class = KeyError

            if isinstance(e, (not_found_class, KeyError, ValueError)):
                # Genuine "not found" — miss, not error
                return (None, "miss")
            else:
                # Operational fault (OSError, IOError, library bug, etc.)
                return (None, "error")
        if r.location.latitude is None or r.location.longitude is None:
            return (None, "miss")
        return (r.location.latitude, r.location.longitude, r.country.iso_code or "??"), "hit"

    def enrich(self, ev: Event) -> Optional[Event]:
        src_coords, src_status = self._locate(ev.src_ip)

        # Count source result
        if src_status == "hit":
            self.stats["hits"] += 1
        elif src_status == "miss":
            self.stats["misses"] += 1
        elif src_status == "error":
            self.stats["errors"] += 1
        elif src_status == "private":
            self.stats["private"] += 1

        # Drop event if source cannot be located (miss or error)
        if src_status in ("miss", "error"):
            return None

        # Set source coordinates
        ev.src_lat, ev.src_lon, ev.src_country = src_coords

        # Locate destination
        dst_coords, dst_status = self._locate(ev.dst_ip)
        if dst_status in ("hit", "private"):
            ev.dst_lat, ev.dst_lon, ev.dst_country = dst_coords

        return ev
