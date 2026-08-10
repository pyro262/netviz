import pytest

from netviz.events import Event
from netviz.stats import RollingCounter, Stats, foreign_country


def flow(ts=1000.0, **kw):
    kw.setdefault("src_ip", "10.0.0.1")
    kw.setdefault("dst_ip", "8.8.8.8")
    kw.setdefault("bytes", 100)
    kw.setdefault("proto", 6)
    return Event(ts=ts, kind="flow", **kw)


def block(ts=1000.0, **kw):
    kw.setdefault("src_ip", "10.0.0.1")
    kw.setdefault("dst_ip", "1.2.3.4")
    kw.setdefault("bytes", 40)
    kw.setdefault("proto", 6)
    return Event(ts=ts, kind="block", **kw)


class TestRollingCounter:
    def test_counts_within_the_window(self):
        c = RollingCounter(60.0, 60)
        for i in range(10):
            c.add("x", 1000.0 + i)
        assert c.total(1009.0) == 10

    def test_expires_past_the_window(self):
        c = RollingCounter(60.0, 60)
        c.add("x", 1000.0)
        assert c.total(1000.0) == 1
        # A full window later the bucket has been lapped and is not live.
        assert c.total(1000.0 + 61) == 0

    def test_a_lapped_bucket_is_cleared_not_added_to(self):
        """The failure this guards: reusing a slot without checking its epoch
        makes an hour-old count survive forever as long as traffic keeps
        landing in the same slot index."""
        c = RollingCounter(60.0, 60)
        c.add("x", 1000.0)
        c.add("x", 1000.0 + 60)      # same slot index, one lap later
        assert c.total(1000.0 + 60) == 1

    def test_top_is_by_count_then_label(self):
        c = RollingCounter(60.0, 60)
        for _ in range(3):
            c.add("CN", 1000.0)
        c.add("RU", 1000.0)
        c.add("BY", 1000.0)
        assert c.top(1000.0, 5) == [("CN", 3), ("BY", 1), ("RU", 1)]

    def test_top_truncates(self):
        c = RollingCounter(60.0, 60)
        for i, cc in enumerate(["A", "B", "C", "D", "E", "F"]):
            for _ in range(10 - i):
                c.add(cc, 1000.0)
        assert [cc for cc, _ in c.top(1000.0, 5)] == ["A", "B", "C", "D", "E"]

    def test_tally_merges_live_buckets_only(self):
        c = RollingCounter(60.0, 60)
        c.add("CN", 1000.0)
        c.add("CN", 1030.0)
        c.add("RU", 1055.0)
        assert c.tally(1059.0) == {"CN": 2, "RU": 1}
        # 1000 has aged out; 1030 and 1055 have not.
        assert c.tally(1080.0) == {"CN": 1, "RU": 1}

    def test_rejects_degenerate_sizes(self):
        with pytest.raises(ValueError):
            RollingCounter(60.0, 0)
        with pytest.raises(ValueError):
            RollingCounter(0.0, 10)


class TestForeignCountry:
    def test_prefers_the_destination(self):
        assert foreign_country(block(src_country="US", dst_country="CN")) == "CN"

    def test_falls_back_to_the_source(self):
        assert foreign_country(block(src_country="RU", dst_country=None)) == "RU"

    def test_outbound_block_shape_is_not_filed_under_the_placeholder(self):
        """Every geo policy on an outbound-blocking router leaves src_country
        as `--` and puts the blocked country in the destination. Reading the
        source would file the whole rail under one `--` row."""
        assert foreign_country(block(src_country="--", dst_country="IR")) == "IR"

    def test_none_when_neither_end_is_placeable(self):
        assert foreign_country(block(src_country="--", dst_country=None)) is None
        assert foreign_country(block(src_country="", dst_country="X")) is None


class TestStats:
    def test_flows_per_min_counts_only_the_last_minute(self):
        s = Stats(clock=lambda: 5000.0)
        for i in range(5):
            s.note(flow(), now=5000.0 + i)
        assert s.snapshot(5004.0)["netflow"]["flows_per_min"] == 5
        assert s.snapshot(5100.0)["netflow"]["flows_per_min"] == 0

    def test_blocks_are_counted_by_far_country(self):
        s = Stats(clock=lambda: 5000.0)
        for _ in range(3):
            s.note(block(src_country="--", dst_country="CN"), now=5000.0)
        s.note(block(src_country="--", dst_country="RU"), now=5000.0)
        snap = s.snapshot(5000.0)
        assert snap["blocks"]["total"] == 4
        assert [(r["cc"], r["n"]) for r in snap["blocks"]["top"]] == [
            ("CN", 3), ("RU", 1)]

    def test_unplaceable_blocks_still_reach_the_total(self):
        """The globe draws an arc for a block GeoIP could not place; the rail's
        total has to agree with what the wall shows."""
        s = Stats(clock=lambda: 5000.0)
        s.note(block(src_country="--", dst_country=None), now=5000.0)
        snap = s.snapshot(5000.0)
        assert snap["blocks"]["total"] == 1
        assert snap["blocks"]["unplaced"] == 1
        assert snap["blocks"]["top"] == []

    def test_blocks_do_not_count_as_flows(self):
        s = Stats(clock=lambda: 5000.0)
        s.note(block(dst_country="CN"), now=5000.0)
        assert s.snapshot(5000.0)["netflow"]["flows_per_min"] == 0

    def test_lag_is_the_age_of_the_newest_event(self):
        s = Stats(clock=lambda: 5000.0)
        s.note(flow(ts=4998.5), now=5000.0)
        assert s.snapshot(5000.0)["netflow"]["lag_seconds"] == pytest.approx(1.5)

    def test_lag_never_goes_negative_on_router_clock_skew(self):
        s = Stats(clock=lambda: 5000.0)
        s.note(flow(ts=5010.0), now=5000.0)
        assert s.snapshot(5000.0)["netflow"]["lag_seconds"] == 0.0

    def test_snapshot_is_json_safe_without_the_live_sources(self):
        """Synthetic mode has no decoder, no syslog protocol and no enricher.
        Those rows must come back as null rather than the collector failing."""
        import json
        s = Stats(clock=lambda: 5000.0)
        snap = s.snapshot(5000.0)
        assert snap["netflow"]["ipfix"] is None
        assert snap["netflow"]["syslog"] is None
        assert snap["geoip"]["miss_rate"] is None
        json.dumps(snap)

    def test_snapshot_carries_the_live_sources_when_attached(self):
        s = Stats(clock=lambda: 5000.0)
        s.decoder = type("D", (), {"stats": {"records": 5, "no_template": 1}})()
        s.syslog = type("S", (), {"stats": {"datagrams": 2}})()
        s.enricher = type("E", (), {"miss_rate": lambda self: 0.059})()
        snap = s.snapshot(5000.0)
        assert snap["netflow"]["ipfix"]["records"] == 5
        assert snap["netflow"]["syslog"]["datagrams"] == 2
        assert snap["geoip"]["miss_rate"] == pytest.approx(0.059)

    def test_a_day_of_blocks_is_still_in_the_window(self):
        s = Stats(clock=lambda: 0.0)
        base = 1_000_000.0
        # One block an hour for 23 hours, all inside the 24h window.
        for h in range(23):
            s.note(block(dst_country="CN"), now=base + h * 3600)
        assert s.snapshot(base + 22 * 3600)["blocks"]["total"] == 23


# --- Sparkline series -------------------------------------------------------

class TestSeries:
    """One count per bucket in time order, for the rail's sparklines."""

    def test_is_ordered_oldest_first(self):
        c = RollingCounter(60.0, 6)          # 10-second buckets
        c.add("RU", 1000.0)
        c.add("RU", 1030.0)
        c.add("RU", 1030.0)
        s = c.series("RU", 1030.0)
        assert len(s) == 6
        assert s[-1] == 2                    # newest bucket last
        assert s[-4] == 1                    # 30s earlier, three buckets back
        assert sum(s) == 3

    def test_empty_buckets_are_zero_not_omitted(self):
        """A sparkline whose gaps close up draws a quiet hour as a busy one."""
        c = RollingCounter(60.0, 6)
        c.add("RU", 1000.0)
        s = c.series("RU", 1050.0)
        assert len(s) == 6
        assert s.count(0) == 5
        assert sum(s) == 1

    def test_a_label_never_seen_is_all_zeroes(self):
        c = RollingCounter(60.0, 6)
        c.add("RU", 1000.0)
        assert c.series("CN", 1000.0) == [0] * 6

    def test_lapped_buckets_do_not_survive(self):
        """The same slot index comes round again; an old count in it must not
        reappear an hour later as though it were current."""
        c = RollingCounter(60.0, 6)
        c.add("RU", 1000.0)
        assert sum(c.series("RU", 1000.0)) == 1
        assert c.series("RU", 1000.0 + 60.0) == [0] * 6

    def test_series_agrees_with_tally_over_the_window(self):
        c = RollingCounter(60.0, 6)
        for t in (1000.0, 1005.0, 1021.0, 1039.0):
            c.add("RU", t)
        now = 1050.0
        assert sum(c.series("RU", now)) == c.tally(now).get("RU", 0)


def test_snapshot_carries_a_sparkline_per_top_row():
    from netviz.stats import RECENT_SLOTS
    s = Stats(clock=lambda: 1000.0)
    for _ in range(3):
        s.note(block(dst_country="RU"), 1000.0)
    s.note(block(dst_country="CN"), 1000.0)
    snap = s.snapshot(1000.0)
    rows = snap["blocks"]["top"]
    assert [r["cc"] for r in rows] == ["RU", "CN"]
    for row in rows:
        assert len(row["spark"]) == RECENT_SLOTS
        assert sum(row["spark"]) == row["n"]
    assert snap["blocks"]["spark_seconds"] == 3600.0


def test_sparkline_is_the_last_hour_not_the_last_day():
    """The 24h count and the sparkline answer different questions: a country
    quiet for an hour still shows its day total, with a flat line."""
    s = Stats(clock=lambda: 100000.0)
    for _ in range(5):
        s.note(block(dst_country="RU"), 100000.0 - 7200.0)      # two hours ago
    snap = s.snapshot(100000.0)
    row = snap["blocks"]["top"][0]
    assert row["cc"] == "RU"
    assert row["n"] == 5
    assert sum(row["spark"]) == 0
