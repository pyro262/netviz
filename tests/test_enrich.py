import pytest
from netviz.enrich import Enricher
from netviz.events import Event


class FakeReader:
    """Stands in for geoip2.database.Reader so tests need no .mmdb file."""
    KNOWN = {"203.0.113.9": (55.75, 37.62, "RU")}

    def __init__(self):
        # Per instance, not per class: as a class attribute the OSError
        # injected by one test stayed set for every test defined after it,
        # which silently turned their misses into errors.
        self.BEHAVIOR = {}  # Can be set to inject fault conditions

    def city(self, ip):
        if self.BEHAVIOR.get("raise_oserror"):
            raise OSError("Simulated disk failure")
        if ip not in self.KNOWN:
            raise KeyError(ip)
        lat, lon, cc = self.KNOWN[ip]
        return type("R", (), {
            "location": type("L", (), {"latitude": lat, "longitude": lon})(),
            "country": type("C", (), {"iso_code": cc})(),
        })()


def make_enricher():
    e = Enricher.__new__(Enricher)
    e._reader = FakeReader()
    e._home = (30.3, -97.7)
    e.stats = {"hits": 0, "misses": 0, "private": 0, "errors": 0, "local": 0}
    return e


def _ev(src, dst="192.168.0.50"):
    return Event(ts=0.0, kind="flow", src_ip=src, dst_ip=dst, bytes=1, proto=6)


def test_public_source_is_located():
    out = make_enricher().enrich(_ev("203.0.113.9"))
    assert out.src_lat == 55.75
    assert out.src_country == "RU"


def test_private_destination_uses_home_coordinates():
    out = make_enricher().enrich(_ev("203.0.113.9"))
    assert (out.dst_lat, out.dst_lon) == (30.3, -97.7)
    assert out.dst_country == "--"


def test_unlocatable_source_is_dropped_and_counted():
    e = make_enricher()
    assert e.enrich(_ev("198.51.100.200")) is None
    assert e.stats["misses"] == 1


def test_private_source_is_located_home_not_counted_as_miss():
    e = make_enricher()
    out = e.enrich(_ev("192.168.10.20", dst="203.0.113.9"))
    assert out.src_lat == 30.3
    assert e.stats["misses"] == 0
    assert e.stats["private"] == 1


def test_miss_rate_reports_zero_when_no_events():
    assert make_enricher().miss_rate() == 0.0


def test_miss_rate_computed_over_attempts():
    e = make_enricher()
    e.enrich(_ev("203.0.113.9"))
    e.enrich(_ev("198.51.100.200"))
    assert e.miss_rate() == pytest.approx(0.5)


def test_not_found_error_counts_as_miss_not_error():
    e = make_enricher()
    assert e.enrich(_ev("198.51.100.200")) is None
    assert e.stats["misses"] == 1
    assert e.stats["errors"] == 0


def test_operational_fault_counts_as_error_not_miss():
    e = make_enricher()
    e._reader.BEHAVIOR["raise_oserror"] = True
    assert e.enrich(_ev("203.0.113.9")) is None
    assert e.stats["errors"] == 1
    assert e.stats["misses"] == 0


def test_miss_rate_unaffected_by_errors():
    e = make_enricher()
    e._reader.BEHAVIOR["raise_oserror"] = True
    e.enrich(_ev("203.0.113.9"))  # Error on source
    e.enrich(_ev("203.0.113.9"))  # Error on source
    # miss_rate is 0 because errors don't count as misses
    assert e.miss_rate() == 0.0
    assert e.stats["errors"] == 2


class TestResolveMmdb:
    """Which database a run actually opens. A clone with no MaxMind account
    must still geolocate, or the wall draws nothing at all on its first run."""

    def test_the_configured_path_wins_when_it_exists(self, tmp_path):
        from netviz.enrich import resolve_mmdb

        wanted = tmp_path / "GeoLite2-City.mmdb"
        wanted.write_bytes(b"x")
        (tmp_path / "dbip-city-lite.mmdb").write_bytes(b"x")

        assert resolve_mmdb(str(wanted)) == str(wanted)

    def test_falls_back_to_dbip_when_geolite_is_absent(self, tmp_path):
        from netviz.enrich import resolve_mmdb

        dbip = tmp_path / "dbip-city-lite.mmdb"
        dbip.write_bytes(b"x")

        got = resolve_mmdb(str(tmp_path / "GeoLite2-City.mmdb"))

        assert got == str(dbip)

    def test_prefers_geolite_over_dbip_when_both_are_present(self, tmp_path):
        """GeoLite2 knows anycast addresses have no single location; DB-IP
        answers with a registrant-country guess. Where someone has both, the
        better database should be the one that gets opened."""
        from netviz.enrich import resolve_mmdb

        geolite = tmp_path / "GeoLite2-City.mmdb"
        geolite.write_bytes(b"x")
        (tmp_path / "dbip-city-lite.mmdb").write_bytes(b"x")

        got = resolve_mmdb(str(tmp_path / "some-other-name.mmdb"))

        assert got == str(geolite)

    def test_an_explicit_env_path_is_honoured_even_with_fallbacks_around(
            self, tmp_path):
        from netviz.enrich import resolve_mmdb

        explicit = tmp_path / "my-own.mmdb"
        explicit.write_bytes(b"x")
        (tmp_path / "dbip-city-lite.mmdb").write_bytes(b"x")

        assert resolve_mmdb(str(explicit)) == str(explicit)

    def test_returns_the_configured_path_when_nothing_is_found(self, tmp_path):
        """So the caller raises an error naming the path the operator asked
        for, rather than one naming a fallback they never configured."""
        from netviz.enrich import resolve_mmdb

        wanted = str(tmp_path / "GeoLite2-City.mmdb")

        assert resolve_mmdb(wanted) == wanted

    def test_a_bare_filename_looks_in_the_working_directory(self, tmp_path, monkeypatch):
        from netviz.enrich import resolve_mmdb

        monkeypatch.chdir(tmp_path)
        (tmp_path / "dbip-city-lite.mmdb").write_bytes(b"x")

        assert resolve_mmdb("GeoLite2-City.mmdb") == "dbip-city-lite.mmdb"


# --- CGNAT and non-routable space -------------------------------------------
# Both used to fall through to the database, miss, and inflate the miss rate
# that the GeoIP alarm watches. They are two different problems: a CGNAT
# address is a real host, a multicast group is not one anywhere.

@pytest.mark.parametrize("ip", ["100.64.0.1", "100.100.5.6", "100.127.255.254"])
def test_cgnat_source_is_home_and_not_a_miss(ip):
    e = make_enricher()
    out = e.enrich(_ev(ip, dst="203.0.113.9"))
    assert (out.src_lat, out.src_lon) == (30.3, -97.7)
    assert out.src_country == "--"
    # Only the source end is counted, so a located destination adds no hit.
    assert e.stats == {"hits": 0, "misses": 0, "private": 1, "errors": 0, "local": 0}


@pytest.mark.parametrize("ip", ["100.63.255.255", "100.128.0.0"])
def test_addresses_either_side_of_cgnat_are_not_private(ip):
    """100.64.0.0/10 is a /10, not a /8 -- the neighbours are ordinary public
    space and must still be asked of the database."""
    e = make_enricher()
    assert e.enrich(_ev(ip)) is None
    assert e.stats["misses"] == 1
    assert e.stats["private"] == 0


@pytest.mark.parametrize("ip", [
    "224.0.0.251",        # mDNS, constant on any LAN
    "239.255.255.250",    # SSDP
    "255.255.255.255",    # broadcast (inside 240/4)
    "0.0.0.0",
    "ff02::fb",           # link-local mDNS: multicast *and* link-local
    "ff05::1",
])
def test_nonroutable_is_dropped_as_local_not_missed(ip):
    e = make_enricher()
    assert e.enrich(_ev(ip, dst="203.0.113.9")) is None
    assert e.stats["local"] == 1
    assert e.stats["misses"] == 0
    assert e.stats["private"] == 0


def test_nonroutable_destination_drops_the_event():
    """A flow to a multicast group has no far end to draw."""
    e = make_enricher()
    assert e.enrich(_ev("203.0.113.9", dst="224.0.0.251")) is None
    assert e.stats["local"] == 1


def test_local_is_outside_the_miss_rate():
    e = make_enricher()
    for _ in range(9):
        e.enrich(_ev("224.0.0.251", dst="203.0.113.9"))
    e.enrich(_ev("203.0.113.9"))
    assert e.stats["local"] == 9
    assert e.miss_rate() == 0.0


# --- Router geo tables on block events --------------------------------------
# The router blocks on xt_geoip and the globe draws on MaxMind. Where they
# disagree the arc used to land in a country that is not on the block list,
# which reads as a display bug when the router was right by its own data.

class FakeXt:
    """Stands in for XtGeoIP: a flat map, no file format involved."""
    def __init__(self, known=None):
        self.known = known or {"198.51.100.7": "HK", "198.51.100.9": "RU"}

    def lookup(self, ip):
        return self.known.get(ip)


def make_router_enricher(centroids=None):
    e = make_enricher()
    e.xt = FakeXt()
    e.centroids = centroids if centroids is not None else {
        "HK": (22.3983, 114.1138), "RU": (62.2381, 99.3997)}
    e.stats_xt = {"agreed": 0, "corrected": 0, "placed": 0}
    return e


def _block(src, dst):
    return Event(ts=0.0, kind="block", src_ip=src, dst_ip=dst, bytes=1, proto=6)


def test_block_destination_moves_to_the_routers_country():
    """The case that exposed the disagreement: MaxMind had this address in one
    country, the router blocked it as another."""
    e = make_router_enricher()
    e._reader.KNOWN = dict(FakeReader.KNOWN)
    e._reader.KNOWN["198.51.100.7"] = (1.29, 103.85, "SG")
    out = e.enrich(_block("192.168.0.50", "198.51.100.7"))
    assert out.dst_country == "HK"
    assert (out.dst_lat, out.dst_lon) == (22.3983, 114.1138)
    assert e.stats_xt["corrected"] == 1


def test_agreement_is_counted_separately_and_moves_to_the_centroid():
    e = make_router_enricher()
    e._reader.KNOWN = dict(FakeReader.KNOWN)
    e._reader.KNOWN["198.51.100.7"] = (22.30, 114.17, "HK")
    out = e.enrich(_block("192.168.0.50", "198.51.100.7"))
    assert out.dst_country == "HK"
    assert e.stats_xt["corrected"] == 0
    assert e.stats_xt["agreed"] == 1


def test_a_block_maxmind_cannot_place_is_drawn_anyway():
    """Previously dropped: no coordinates, no arc. The router could place it."""
    e = make_router_enricher()
    out = e.enrich(_block("192.168.0.50", "198.51.100.7"))
    assert out is not None
    assert out.dst_country == "HK"
    assert e.stats_xt["placed"] == 1


def test_an_inbound_block_is_rescued_on_the_source_end():
    """On an inbound-blocking router the foreign end is the source, and a
    source MaxMind cannot place is dropped one step before the override runs."""
    e = make_router_enricher()
    out = e.enrich(_block("198.51.100.9", "192.168.0.50"))
    assert out is not None
    assert out.src_country == "RU"
    assert (out.src_lat, out.src_lon) == (62.2381, 99.3997)
    assert (out.dst_lat, out.dst_lon) == (30.3, -97.7)
    assert e.stats_xt["placed"] == 1


def test_flows_are_never_touched_by_the_router_tables():
    """A flow asks 'where is this host', which is MaxMind's question and the
    one it is better at. Only blocks ask what the router believed."""
    e = make_router_enricher()
    e._reader.KNOWN = dict(FakeReader.KNOWN)
    e._reader.KNOWN["198.51.100.7"] = (1.29, 103.85, "SG")
    out = e.enrich(_ev("192.168.0.50", dst="198.51.100.7"))
    assert out.dst_country == "SG"
    assert (out.dst_lat, out.dst_lon) == (1.29, 103.85)
    assert e.stats_xt == {"agreed": 0, "corrected": 0, "placed": 0}


def test_destination_wins_when_both_ends_are_in_watched_countries():
    e = make_router_enricher()
    out = e.enrich(_block("198.51.100.9", "198.51.100.7"))
    assert out.dst_country == "HK"


def test_no_tables_leaves_maxmind_alone():
    e = make_enricher()
    e.xt = None
    e.stats_xt = {"agreed": 0, "corrected": 0, "placed": 0}
    out = e.enrich(_block("192.168.0.50", "203.0.113.9"))
    assert out.dst_country == "RU"
    assert (out.dst_lat, out.dst_lon) == (55.75, 37.62)


def test_a_country_with_no_outline_keeps_the_maxmind_answer():
    """The router can block a country this install has no bake for. Inventing
    coordinates would be worse than the disagreement."""
    e = make_router_enricher(centroids={})
    e._reader.KNOWN = dict(FakeReader.KNOWN)
    e._reader.KNOWN["198.51.100.7"] = (1.29, 103.85, "SG")
    out = e.enrich(_block("192.168.0.50", "198.51.100.7"))
    assert out.dst_country == "SG"
    assert (out.dst_lat, out.dst_lon) == (1.29, 103.85)


def test_private_ends_are_not_asked_of_the_router_tables():
    e = make_router_enricher()
    e.xt.known["192.168.0.50"] = "CN"       # would be absurd, must not be used
    out = e.enrich(_block("192.168.0.50", "198.51.100.7"))
    assert out.src_country == "--"
    assert out.dst_country == "HK"
