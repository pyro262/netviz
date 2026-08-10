"""Environment-variable config. Defaults are the values that work in the
compose file; nothing here is a secret except INFLUX_TOKEN."""
import os
from dataclasses import dataclass, field

# Up to three networks can be drawn in their own colour -- a server VLAN, an
# IoT segment, a guest network. Matched as an address prefix against either end
# of a flow.
#
# These live in the environment rather than in the tracked config.js because a
# LAN layout is site-specific: the prefixes say how somebody's network is laid
# out, and a public repo should not carry them. Colour and label are here too
# so one file configures the whole class.
#
# Defaults are colours only. With no prefix set a slot is simply off, so an
# install that highlights nothing needs no configuration at all.
HIGHLIGHT_SLOTS = 3
HIGHLIGHT_DEFAULT_COLORS = ("#a855f7", "#22d3ee", "#4ade80")
# Per-colour brightness trim. Cyan and green are the highest-luminance hues on
# a display and clear the bloom threshold sooner than a violet of the same
# nominal value, so they are knocked back further. 0.51 for cyan is measured on
# a real wall; the other two are reasoned from it and unmeasured.
HIGHLIGHT_DEFAULT_GAINS = (0.70, 0.51, 0.55)


def _highlight_networks() -> list[dict]:
    """Read NETVIZ_HIGHLIGHT{1,2,3}_{PREFIX,LABEL,COLOR} into a list.

    A slot with no prefix is kept, not dropped, so the renderer's slot N always
    means the same configured network whether or not slot N-1 is in use --
    otherwise turning off one network would silently recolour another.
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
    buffer_path: str = os.environ.get("NETVIZ_BUFFER", "/state/buffer.jsonl")
    # IPFIX templates survive a restart here; without it every restart drops
    # data records until the router's next template set.
    template_path: str = os.environ.get("NETVIZ_TEMPLATES", "/state/templates.json")
    influx_url: str = os.environ.get("INFLUX_URL", "http://influxdb:8086")
    influx_org: str = os.environ.get("INFLUX_ORG", "home")
    influx_bucket: str = os.environ.get("INFLUX_BUCKET", "netviz")
    influx_token: str = os.environ.get("INFLUX_TOKEN", "")
    home_lat: float = float(os.environ.get("NETVIZ_HOME_LAT", "30.3"))
    home_lon: float = float(os.environ.get("NETVIZ_HOME_LON", "-97.7"))
    highlight_networks: list[dict] = field(default_factory=_highlight_networks)

    def display_config(self) -> dict:
        """The subset of config the browser is allowed to know.

        Served at /config.json. Deliberately a whitelist built by hand rather
        than a dump of this object: Config also holds the Influx token, and a
        page that gets handed the whole thing once would carry every secret
        added to it later.
        """
        return {"highlight": {"networks": self.highlight_networks}}
    flush_seconds: float = float(os.environ.get("NETVIZ_FLUSH_SECONDS", "10"))
