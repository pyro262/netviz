"""Environment-variable config. Defaults are the values that work in the
compose file; nothing here is a secret except INFLUX_TOKEN."""
import os
from dataclasses import dataclass, field

# Up to three networks can be drawn in their own color -- a server VLAN, an
# IoT segment, a guest network. Matched as an address prefix against either end
# of a flow.
#
# These live in the environment rather than in the tracked config.js because a
# LAN layout is site-specific: the prefixes say how somebody's network is laid
# out, and a public repo should not carry them. Color and label are here too
# so one file configures the whole class.
#
# Defaults are colors only. With no prefix set a slot is simply off, so an
# install that highlights nothing needs no configuration at all.
HIGHLIGHT_SLOTS = 3
HIGHLIGHT_DEFAULT_COLORS = ("#a855f7", "#22d3ee", "#4ade80")
# Per-color brightness trim. Cyan and green are the highest-luminance hues on
# a display and clear the bloom threshold sooner than a violet of the same
# nominal value, so they are knocked back further. 0.51 for cyan is measured on
# a real wall; the other two are reasoned from it and unmeasured.
HIGHLIGHT_DEFAULT_GAINS = (0.70, 0.51, 0.55)


def _highlight_networks() -> list[dict]:
    """Read NETVIZ_HIGHLIGHT{1,2,3}_{PREFIX,LABEL,COLOR} into a list.

    A slot with no prefix is kept, not dropped, so the renderer's slot N always
    means the same configured network whether or not slot N-1 is in use --
    otherwise turning off one network would silently recolor another.
    """
    out = []
    for i in range(1, HIGHLIGHT_SLOTS + 1):
        prefix = os.environ.get(f"NETVIZ_HIGHLIGHT{i}_PREFIX", "").strip()
        out.append({
            "prefix": prefix,
            "label": os.environ.get(f"NETVIZ_HIGHLIGHT{i}_LABEL", f"network {i}"),
            "color": os.environ.get(f"NETVIZ_HIGHLIGHT{i}_COLOR",
                                    HIGHLIGHT_DEFAULT_COLORS[i - 1]),
            "gain": float(os.environ.get(f"NETVIZ_HIGHLIGHT{i}_GAIN",
                                         HIGHLIGHT_DEFAULT_GAINS[i - 1])),
        })
    return out


@dataclass
class Config:
    ipfix_port: int = int(os.environ.get("NETVIZ_IPFIX_PORT", "2055"))
    syslog_port: int = int(os.environ.get("NETVIZ_SYSLOG_PORT", "5514"))
    ws_port: int = int(os.environ.get("NETVIZ_WS_PORT", "8099"))
    # How many rejected syslog lines to log once, for building a new parser
    # branch against the real stream. 0 in normal operation.
    log_unparsed: int = int(os.environ.get("NETVIZ_LOG_UNPARSED", "0"))
    # Falls back to the other supported build in the same directory when this
    # file is absent -- see enrich.resolve_mmdb. A clone with no MaxMind
    # account gets dbip-city-lite.mmdb from tools/fetch_dbip.sh and works.
    mmdb_path: str = os.environ.get("NETVIZ_MMDB", "/data/GeoLite2-City.mmdb")
    # The router's own geo-IP tables, from tools/fetch_xt_geoip.sh. Absent is
    # the ordinary case: without them block events fall back to MaxMind, which
    # is what every install did before this existed.
    xt_geoip_dir: str = os.environ.get("NETVIZ_XT_GEOIP_DIR", "/data/xt_geoip")
    # "owner/repo" to check for newer releases. Set it empty to disable, which
    # also stops the request being made at all.
    #
    # On by default, pointing at upstream. This was opt-in in 0.2.1 and that
    # was the wrong call for released software: the people most likely to be
    # running a stale build are exactly the ones who never read the
    # configuration reference, so an opt-in update notice reaches everybody
    # except its audience. The cost is one unauthenticated GET to GitHub once
    # an hour, carrying nothing about the network it runs on, and the README
    # says so plainly rather than leaving it to be discovered.
    update_repo: str = os.environ.get("NETVIZ_UPDATE_REPO",
                                      "pyro262/netviz").strip()
    buffer_path: str = os.environ.get("NETVIZ_BUFFER", "/state/buffer.jsonl")
    # IPFIX templates survive a restart here; without it every restart drops
    # data records until the router's next template set.
    template_path: str = os.environ.get("NETVIZ_TEMPLATES", "/state/templates.json")
    # The hourly global cloud mosaic, cached beside the templates and for the
    # same reason: a restart must not cost a 7 MB download and leave the globe
    # bare until the next publication.
    state_dir: str = os.environ.get("NETVIZ_STATE_DIR", "/state")
    cloud_path: str = os.environ.get("NETVIZ_CLOUDS_PATH", "/state/clouds.png")
    # Off with NETVIZ_CLOUDS=0. The fetch is ~7 MB an hour from AWS Open Data,
    # which is a cost a deployment is entitled to decline; with it off nothing
    # is requested, /clouds.png 404s and the renderer draws no shell.
    clouds_enabled: bool = os.environ.get("NETVIZ_CLOUDS", "1").strip() not in ("0", "false", "no")
    # Off with NETVIZ_LIGHTNING=0. The fetch is ~80 KB per 10 minutes from
    # Blitzortung's public archive -- an order of magnitude less than the cloud
    # mosaic -- but it is somebody else's volunteer bandwidth, so a deployment
    # that does not draw the layer should not be asking for it.
    lightning_enabled: bool = os.environ.get("NETVIZ_LIGHTNING", "1").strip() not in ("0", "false", "no")
    influx_url: str = os.environ.get("INFLUX_URL", "http://influxdb:8086")
    influx_org: str = os.environ.get("INFLUX_ORG", "home")
    influx_bucket: str = os.environ.get("INFLUX_BUCKET", "netviz")
    influx_token: str = os.environ.get("INFLUX_TOKEN", "")
    home_lat: float = float(os.environ.get("NETVIZ_HOME_LAT", "30.3"))
    home_lon: float = float(os.environ.get("NETVIZ_HOME_LON", "-97.7"))
    highlight_networks: list[dict] = field(default_factory=_highlight_networks)
    # Public resolvers to hide from the display on top of the built-in list in
    # config.js. Comma separated; an entry ending in "." or ":" is a prefix.
    # Here rather than only in config.js so a container deployment can add its
    # provider's resolver without a rebuild.
    extra_resolvers: list[str] = field(default_factory=lambda: [
        s.strip() for s in os.environ.get("NETVIZ_EXTRA_RESOLVERS", "").split(",")
        if s.strip()
    ])

    def display_config(self) -> dict:
        """The subset of config the browser is allowed to know.

        Served at /config.json. Deliberately a whitelist built by hand rather
        than a dump of this object: Config also holds the Influx token, and a
        page that gets handed the whole thing once would carry every secret
        added to it later.

        The home position is in here because the page cannot derive it: the
        renderer learns where home is only from the arcs, and the star ramp
        needs the local sunrise before any traffic has arrived. It is no more
        exposure than the display already gives -- every arc converges on it.
        """
        return {
            "highlight": {"networks": self.highlight_networks},
            "home": {"lat": self.home_lat, "lon": self.home_lon},
            "resolvers": {"extra": self.extra_resolvers},
        }
    flush_seconds: float = float(os.environ.get("NETVIZ_FLUSH_SECONDS", "10"))
