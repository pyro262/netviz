import ipaddress

from netviz.synthetic import SyntheticFeed, BLOCKED_COUNTRIES


def test_block_events_come_from_blocked_countries():
    f = SyntheticFeed(seed=1)
    for _ in range(50):
        assert f.next_block().src_country in BLOCKED_COUNTRIES


def test_events_are_already_enriched():
    ev = SyntheticFeed(seed=2).next_flow()
    assert ev.src_lat is not None and ev.src_lon is not None
    assert ev.dst_lat is not None


def test_seed_makes_output_reproducible():
    a = [e.src_ip for e in (SyntheticFeed(seed=3).next_flow() for _ in range(5))]
    b = [e.src_ip for e in (SyntheticFeed(seed=3).next_flow() for _ in range(5))]
    assert a == b


def test_blocked_country_list_matches_the_firewall():
    assert len(BLOCKED_COUNTRIES) == 21
    for cc in ("RU", "CN", "KP", "IR"):
        assert cc in BLOCKED_COUNTRIES


def test_flow_and_block_kinds_are_correct():
    f = SyntheticFeed(seed=4)
    assert f.next_flow().kind == "flow"
    assert f.next_block().kind == "block"


def test_jitter_stays_within_valid_lat_lon_bounds():
    """Jitter must clamp latitude to [-90, 90] and wrap longitude to [-180, 180]."""
    # Use a seed that produces edge cases near poles/antimeridian.
    f = SyntheticFeed(seed=5)
    for _ in range(200):
        ev = f.next_flow()
        assert -90 <= ev.src_lat <= 90, f"latitude {ev.src_lat} out of bounds"
        assert -180 <= ev.src_lon <= 180, f"longitude {ev.src_lon} out of bounds"
        ev = f.next_block()
        assert -90 <= ev.src_lat <= 90, f"latitude {ev.src_lat} out of bounds"
        assert -180 <= ev.src_lon <= 180, f"longitude {ev.src_lon} out of bounds"


def test_generated_ips_are_never_private_or_reserved():
    """Source IPs must be plausible public addresses, never private/reserved/loopback."""
    f = SyntheticFeed(seed=6)
    for _ in range(500):
        ip_str = f.next_flow().src_ip
        ip_obj = ipaddress.IPv4Address(ip_str)
        assert not ip_obj.is_private, f"IP {ip_str} is private"
        assert not ip_obj.is_loopback, f"IP {ip_str} is loopback"
        assert not ip_obj.is_link_local, f"IP {ip_str} is link-local"
        assert not ip_obj.is_multicast, f"IP {ip_str} is multicast"
        assert not ip_obj.is_reserved, f"IP {ip_str} is reserved"


def test_interleaved_flow_and_block_are_reproducible():
    """Reproducibility holds even when interleaving next_flow() and next_block()."""
    # Create two feeds with the same seed.
    f1 = SyntheticFeed(seed=7)
    f2 = SyntheticFeed(seed=7)

    # Interleave the same sequence of calls on both.
    sequence1 = [
        (f1.next_flow().src_ip, f1.next_flow().src_country),
        (f1.next_block().src_ip, f1.next_block().src_country),
        (f1.next_flow().src_ip, f1.next_flow().src_country),
        (f1.next_block().src_ip, f1.next_block().src_country),
    ]
    sequence2 = [
        (f2.next_flow().src_ip, f2.next_flow().src_country),
        (f2.next_block().src_ip, f2.next_block().src_country),
        (f2.next_flow().src_ip, f2.next_flow().src_country),
        (f2.next_block().src_ip, f2.next_block().src_country),
    ]

    assert sequence1 == sequence2


def test_some_synthetic_flows_land_on_a_highlighted_network():
    """The renderer colours up to three networks separately, and synthetic mode
    is what the renderer is developed against -- so it has to produce traffic
    on every one of them or those classes are never exercised."""
    from netviz.synthetic import DEMO_HIGHLIGHT_PREFIXES, LAN_PREFIX, SyntheticFeed

    gen = SyntheticFeed(seed=7)
    dsts = [gen.next_flow().dst_ip for _ in range(600)]

    highlighted = [d for d in dsts
                   if any(d.startswith(p) for p in DEMO_HIGHLIGHT_PREFIXES)]
    lan = [d for d in dsts if d.startswith(LAN_PREFIX)]
    assert lan, "highlighted flows replaced the ordinary LAN flows entirely"
    assert 0.10 < len(highlighted) / len(dsts) < 0.45
    # Every configured slot has to appear, or a three-class display is being
    # developed against a feed that only ever exercises one of them.
    for prefix in DEMO_HIGHLIGHT_PREFIXES:
        assert any(d.startswith(prefix) for d in dsts), f"nothing on {prefix}"


def test_configured_highlight_prefixes_replace_the_demo_ones():
    """A real deployment sets its own networks in .env; the demo prefixes are
    only there so a bare --synthetic run still shows the classes."""
    from netviz.synthetic import DEMO_HIGHLIGHT_PREFIXES, SyntheticFeed

    gen = SyntheticFeed(seed=7, highlight_prefixes=["172.20.5."])
    dsts = [gen.next_flow().dst_ip for _ in range(400)]

    assert any(d.startswith("172.20.5.") for d in dsts)
    for prefix in DEMO_HIGHLIGHT_PREFIXES:
        assert not any(d.startswith(prefix) for d in dsts)


def test_blank_highlight_prefixes_fall_back_to_the_demo_ones():
    """An unconfigured install passes three empty strings, not an empty list."""
    from netviz.synthetic import DEMO_HIGHLIGHT_PREFIXES, SyntheticFeed

    gen = SyntheticFeed(seed=7, highlight_prefixes=["", "", ""])
    dsts = [gen.next_flow().dst_ip for _ in range(400)]

    assert any(d.startswith(DEMO_HIGHLIGHT_PREFIXES[0]) for d in dsts)


def test_synthetic_flows_carry_ports_including_dns():
    """The renderer drops DNS arcs, so synthetic mode -- which is what the
    renderer is developed against -- has to emit some or that branch is never
    exercised without the router."""
    feed = SyntheticFeed(seed=7)
    flows = [feed.next_flow() for _ in range(400)]
    assert all(f.src_port is not None and f.dst_port is not None for f in flows)
    dns = [f for f in flows if 53 in (f.src_port, f.dst_port)]
    assert 20 <= len(dns) <= 200, f"expected a DNS minority, got {len(dns)}"
