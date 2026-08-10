"""IP to coordinates. Pure over a memory-mapped MaxMind-format database — no
network I/O, so this is the easiest unit in the collector to test."""
import ipaddress
import logging
import os
from typing import Literal, Optional

from .events import Event

log = logging.getLogger("netviz")

PRIVATE_COUNTRY = "--"

# Carrier-grade NAT (RFC 6598). A real host sits behind one of these, it just
# is not individually routable, so it is mapped to home exactly like RFC 1918
# space rather than being asked of a database that will never hold it.
CGNAT_V4 = ipaddress.ip_network("100.64.0.0/10")

# Addresses that are not a host anywhere and never will be: multicast,
# broadcast, "this network", and the reserved v4 top end. mDNS 224.0.0.251 is
# constant on any LAN, so this is a steady trickle rather than a rarity.
#
# These are NOT mapped to home like private space. Home-to-home is a
# zero-length arc drawn on top of the one place the display always has
# something at -- trading a wrong statistic for a visible artifact. They get
# their own status instead, and the event is dropped.
NONROUTABLE_V4 = (
    ipaddress.ip_network("224.0.0.0/4"),    # multicast
    ipaddress.ip_network("240.0.0.0/4"),    # reserved, includes 255.255.255.255
    ipaddress.ip_network("0.0.0.0/8"),      # "this network"
)
NONROUTABLE_V6 = (
    ipaddress.ip_network("ff00::/8"),       # multicast
    ipaddress.ip_network("::/128"),         # unspecified
)

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
        # `local` is deliberately outside the miss_rate denominator: multicast
        # and friends are not a database shortcoming, and counting them as
        # misses inflated the rate that the 20% GeoIP alarm watches.
        self.stats = {"hits": 0, "misses": 0, "private": 0, "errors": 0,
                      "local": 0}

    def close(self) -> None:
        self._reader.close()

    def miss_rate(self) -> float:
        attempts = self.stats["hits"] + self.stats["misses"]
        return self.stats["misses"] / attempts if attempts else 0.0

    def _locate(self, ip: str) -> tuple[Optional[tuple[float, float, str]], Literal["hit", "miss", "error", "private", "local"]]:
        """Locate an IP address. Returns (coordinates, status).

        Status can be:
        - "hit": coordinates found in database
        - "miss": IP not in database (genuine not-found)
        - "error": operational fault (corrupt db, permissions, etc.)
        - "private": private/loopback/link-local/CGNAT address (mapped to home)
        - "local": multicast or otherwise not a host anywhere (event dropped)
        """
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return (None, "miss")
        # Non-routable first: ff02::fb (link-local mDNS) is *both* multicast and
        # link-local, and the link-local branch would map it to home.
        if isinstance(addr, ipaddress.IPv4Address):
            if any(addr in net for net in NONROUTABLE_V4):
                return (None, "local")
        elif any(addr in net for net in NONROUTABLE_V6):
            return (None, "local")
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
               addr in ipaddress.ip_network("192.168.0.0/16") or \
               addr in CGNAT_V4:
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
        elif src_status == "local":
            self.stats["local"] += 1

        # Drop event if source cannot be located (miss or error) or is not a
        # host at all (local).
        if src_status in ("miss", "error", "local"):
            return None

        # Set source coordinates
        ev.src_lat, ev.src_lon, ev.src_country = src_coords

        # Locate destination
        dst_coords, dst_status = self._locate(ev.dst_ip)
        if dst_status == "local":
            # A flow *to* multicast has no far end to draw and no bytes worth
            # attributing to a place. Dropped here rather than kept with empty
            # coordinates, which is how mDNS chatter reached the display.
            self.stats["local"] += 1
            return None
        if dst_status in ("hit", "private"):
            ev.dst_lat, ev.dst_lon, ev.dst_country = dst_coords

        return ev
