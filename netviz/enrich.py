"""IP to coordinates. Pure over a memory-mapped MaxMind-format database — no
network I/O, so this is the easiest unit in the collector to test."""
import ipaddress
import logging
import os
from typing import Any, Literal, Optional

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


def load_centroids(path: str) -> dict[str, tuple[float, float]]:
    """Country centroids from the border bake's index, `{cc: (lat, lon)}`.

    Entries are `[firstSegment, count, lat, lon]`; the first two belong to the
    renderer's draw ranges. An entry without the trailing pair comes from a
    bake older than centroids and is skipped rather than guessed at.
    """
    import json
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as e:
        log.warning("xt_geoip: no country centroids from %s: %s", path, e)
        return {}
    out: dict[str, tuple[float, float]] = {}
    for cc, entry in raw.items():
        if isinstance(entry, list) and len(entry) >= 4:
            out[cc] = (float(entry[2]), float(entry[3]))
    if not out:
        log.warning("xt_geoip: %s has no centroids -- re-run "
                    "tools/bake_geo.py borders", path)
    return out


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
        # Both attached after construction, and both optional: the router's
        # tables are a site's own file and the centroids come from a bake that
        # a clone may not have run. Absent, block events keep the MaxMind
        # answer, which is what every install did before this existed.
        self.xt: Any = None
        self.centroids: dict[str, tuple[float, float]] = {}
        self.stats_xt = {"agreed": 0, "corrected": 0, "placed": 0}
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
        rescued = None

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
            # ...unless it is a block whose source the router's own tables can
            # place. On an inbound-blocking router the foreign end *is* the
            # source, so dropping here would discard exactly the events the
            # wall exists to show, one step before the thing that could have
            # rescued them ran.
            rescued = (src_status == "miss" and ev.kind == "block"
                       and self._router_place(ev.src_ip))
            if not rescued:
                return None
            src_coords = rescued
            self.stats_xt["placed"] += 1

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

        if ev.kind == "block":
            # A source already placed from the tables above is skipped rather
            # than re-resolved -- it would land on the same answer and be
            # counted a second time, once as placed and once as agreed.
            self._apply_router_geoip(
                ev, "done" if rescued else src_status, dst_status)
        return ev

    def _router_place(self, ip: str) -> Optional[tuple[float, float, str]]:
        """Coordinates and country for `ip` from the router's tables, or None
        when there are no tables, no match, or no outline to place it on."""
        if self.xt is None:
            return None
        cc = self.xt.lookup(ip)
        if cc is None:
            return None
        centroid = self.centroids.get(cc)
        if centroid is None:
            return None
        return centroid[0], centroid[1], cc

    def _apply_router_geoip(self, ev: Event, src_status: str,
                            dst_status: str) -> None:
        """Re-place a block's foreign end where the *router* thought it was.

        Blocks only. A flow is a "where in the world is this host" question,
        which is what MaxMind is for and what it is better at; a block is a
        "what did the thing that made this decision believe" question, and only
        the router's own tables can answer that. Mixing the two would move
        every arc on the display, not just the ones the alarm layer is about.

        The end is chosen by the same rule as `foreign_country()` in stats.py
        and `foreignEnd()` in classify.js -- prefer the destination -- because
        every geo policy on an outbound-blocking router puts the blocked
        country there while the source is a LAN address.

        Country *and* coordinates move together, to the blocked country's
        outline centroid. Overriding the label alone would draw the arc into
        Singapore while Hong Kong's outline flashed, which is a worse display
        than the disagreement it set out to fix.
        """
        if self.xt is None:
            return
        ends = (("dst", ev.dst_ip, dst_status), ("src", ev.src_ip, src_status))
        for which, ip, status in ends:
            # Only the placeable public end. A private address is home, and
            # asking the router's tables about it can only waste a bisection;
            # "done" is an end already placed from the tables upstream.
            if status in ("private", "done"):
                continue
            # A country the router blocks on but this install has no outline
            # for yields None here: nothing to move the arc to, so MaxMind's
            # answer stands rather than coordinates being invented.
            placed = self._router_place(ip)
            if placed is None:
                continue
            lat, lon, cc = placed
            before = ev.dst_country if which == "dst" else ev.src_country
            if which == "dst":
                ev.dst_country, ev.dst_lat, ev.dst_lon = cc, lat, lon
            else:
                ev.src_country, ev.src_lat, ev.src_lon = cc, lat, lon
            if before == cc:
                self.stats_xt["agreed"] += 1
            elif before in (None, "", "--", "??"):
                # MaxMind could not place it at all and the router could. These
                # are arcs that previously did not draw.
                self.stats_xt["placed"] += 1
            else:
                self.stats_xt["corrected"] += 1
            return
