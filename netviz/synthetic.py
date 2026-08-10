"""Plausible fake events with no UDM involved. Used to develop the renderer and
to demo the wall before per-policy firewall logging is enabled."""
from .config import Config
import ipaddress
import random
import time

from .events import Event

# The 21 countries in the live geo-block policies.
BLOCKED_COUNTRIES: dict[str, tuple[float, float]] = {
    "IL": (31.8, 35.2), "SA": (24.7, 46.7), "QA": (25.3, 51.5),
    "RO": (44.4, 26.1), "ZA": (-26.2, 28.0), "VN": (21.0, 105.8),
    "RU": (55.7, 37.6), "CN": (39.9, 116.4), "HK": (22.3, 114.2),
    "KP": (39.0, 125.8), "IR": (35.7, 51.4), "BY": (53.9, 27.6),
    "SY": (33.5, 36.3), "CU": (23.1, -82.4), "UA": (50.4, 30.5),
    "KZ": (48.0, 66.9), "PK": (33.7, 73.1), "BD": (23.8, 90.4),
    "NG": (9.1, 7.5), "ID": (-6.2, 106.8), "IN": (28.6, 77.2),
}

# Ordinary destinations for ambient netflow traffic.
AMBIENT_COUNTRIES: dict[str, tuple[float, float]] = {
    "US": (37.8, -122.4), "DE": (52.5, 13.4), "GB": (51.5, -0.1),
    "JP": (35.7, 139.7), "FR": (48.9, 2.4), "NL": (52.4, 4.9),
    "BR": (-23.5, -46.6), "AU": (-33.9, 151.2), "CA": (43.7, -79.4),
    "SG": (1.35, 103.8),
}

# Where synthetic arcs converge. Reads the same NETVIZ_HOME_LAT/LON the live
# path uses, so --synthetic shows the globe centred where the real feed would.
HOME = (Config().home_lat, Config().home_lon)

# Documentation addresses for the fake LAN. Deliberately generic: synthetic
# mode ships in the repo and must not describe anybody's real network.
LAN_PREFIX = "192.168.0."
GATEWAY_IP = "192.168.0.1"

# Used only when no highlighted network is configured, so that a bare
# `--synthetic` run still exercises the highlight classes the renderer is
# developed against. A real deployment sets its own in .env.
DEMO_HIGHLIGHT_PREFIXES = ("10.10.10.", "10.10.20.", "10.10.30.")


class SyntheticFeed:
    def __init__(self, seed: int = 0, highlight_prefixes=None) -> None:
        # Falls back to the demo prefixes rather than to nothing: with no
        # highlighted networks at all the renderer's highlight classes would go
        # untested in the one mode built for testing the renderer.
        self._highlight_prefixes = [p for p in (highlight_prefixes or []) if p] \
            or list(DEMO_HIGHLIGHT_PREFIXES)
        self._rng = random.Random(seed)

    def _pick(self, table: dict[str, tuple[float, float]]) -> tuple[str, float, float]:
        cc = self._rng.choice(sorted(table))
        lat, lon = table[cc]
        # Jitter so repeated hits from one country do not stack into one dot.
        jittered_lat = lat + self._rng.uniform(-2, 2)
        jittered_lon = lon + self._rng.uniform(-2, 2)
        # Clamp latitude to valid range; wrap longitude (cyclic, not clamped).
        jittered_lat = max(-90, min(90, jittered_lat))
        jittered_lon = ((jittered_lon + 180) % 360) - 180
        return cc, jittered_lat, jittered_lon

    def _ip(self) -> str:
        # Generate only plausible public addresses, rejecting private/reserved space.
        while True:
            ip_str = ".".join(str(self._rng.randint(1, 254)) for _ in range(4))
            ip_obj = ipaddress.IPv4Address(ip_str)
            if not (ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local
                    or ip_obj.is_multicast or ip_obj.is_reserved):
                return ip_str

    def _lan_ip(self) -> str:
        """A local address, sometimes on one of the highlighted networks.

        Roughly a quarter of flows land on a highlighted network, spread across
        however many are configured. Those are drawn as their own classes, and
        synthetic mode is what the renderer is developed against -- so it has
        to produce some, or those code paths are never exercised without a
        router to supply the traffic.
        """
        if self._highlight_prefixes and self._rng.random() < 0.25:
            prefix = self._rng.choice(self._highlight_prefixes)
            return f"{prefix}{self._rng.randint(2, 254)}"
        return f"{LAN_PREFIX}{self._rng.randint(2, 254)}"

    def _ports(self) -> tuple[int, int]:
        """A realistic minority of DNS. On the real feed nameserver traffic is
        about a third of all events, and the renderer drops it -- so synthetic
        mode has to produce some or that path is never exercised."""
        if self._rng.random() < 0.25:
            return self._rng.randint(1024, 65535), 53
        return (self._rng.randint(1024, 65535),
                self._rng.choice([443, 443, 443, 80, 8443, 22]))

    def next_flow(self) -> Event:
        cc, lat, lon = self._pick(AMBIENT_COUNTRIES)
        sport, dport = self._ports()
        return Event(
            ts=time.time(), kind="flow", src_ip=self._ip(),
            dst_ip=self._lan_ip(),
            bytes=self._rng.randint(200, 2_000_000),
            proto=self._rng.choice([6, 6, 6, 17]),
            src_port=sport, dst_port=dport,
            src_lat=lat, src_lon=lon, src_country=cc,
            dst_lat=HOME[0], dst_lon=HOME[1], dst_country="--",
        )

    def next_block(self) -> Event:
        cc, lat, lon = self._pick(BLOCKED_COUNTRIES)
        return Event(
            ts=time.time(), kind="block", src_ip=self._ip(),
            dst_ip=GATEWAY_IP,
            bytes=self._rng.randint(40, 1500),
            proto=self._rng.choice([6, 17]),
            src_port=self._rng.randint(1024, 65535),
            dst_port=self._rng.choice([443, 22, 3389, 445]),
            policy_id="GEO-BLOCK-IN",
            src_lat=lat, src_lon=lon, src_country=cc,
            dst_lat=HOME[0], dst_lon=HOME[1], dst_country="--",
        )
