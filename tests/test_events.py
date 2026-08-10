import time
from netviz.events import Event


def test_flow_event_roundtrips_through_wire_format():
    ev = Event(
        ts=1754500000.0,
        kind="flow",
        src_ip="203.0.113.9",
        dst_ip="192.168.0.50",
        bytes=4096,
        proto=6,
        policy_id=None,
    )
    assert Event.from_wire(ev.to_wire()) == ev


def test_wire_format_uses_short_keys_and_millisecond_ts():
    ev = Event(ts=1754500000.5, kind="block", src_ip="198.51.100.7",
               dst_ip="192.168.0.1", bytes=0, proto=6, policy_id="GEO-IN")
    wire = ev.to_wire()
    assert wire["t"] == 1754500000500
    assert wire["k"] == "block"
    assert wire["s"] == "198.51.100.7"
    assert wire["p"] == "GEO-IN"


def test_geo_fields_default_to_none_and_survive_roundtrip():
    ev = Event(ts=time.time(), kind="flow", src_ip="1.1.1.1", dst_ip="8.8.8.8",
               bytes=1, proto=17)
    assert ev.src_lat is None and ev.src_country is None
    ev.src_lat, ev.src_lon, ev.src_country = 37.75, -122.68, "US"
    assert Event.from_wire(ev.to_wire()).src_country == "US"


def test_wire_carries_ports_when_present():
    """Ports ride the wire so the renderer can tell DNS chatter from data.

    They are the only way to identify DNS: 33% of events are nameserver
    traffic and 6% of the bytes, and without ports the renderer cannot
    separate the two.
    """
    ev = Event(ts=1.0, kind="flow", src_ip="1.2.3.4", dst_ip="5.6.7.8",
               bytes=100, proto=17, src_port=44321, dst_port=53)
    w = ev.to_wire()
    assert w["sp"] == 44321
    assert w["dp"] == 53
    back = Event.from_wire(w)
    assert back.src_port == 44321
    assert back.dst_port == 53


def test_wire_omits_ports_when_absent():
    """Absent ports must not become 0 -- 0 is a real port value and would
    read as 'port zero', not as 'unknown'."""
    ev = Event(ts=1.0, kind="flow", src_ip="1.2.3.4", dst_ip="5.6.7.8",
               bytes=100, proto=17)
    w = ev.to_wire()
    assert "sp" not in w
    assert "dp" not in w
    assert Event.from_wire(w).src_port is None
