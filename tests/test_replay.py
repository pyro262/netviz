import json

from netviz.events import Event
from netviz.replay import Replay


def _ev(ts: float, kind: str = "flow") -> Event:
    return Event(ts=ts, kind=kind, src_ip="203.0.113.7", dst_ip="192.168.0.20",
                 bytes=1000, proto=6, src_lat=1.5, src_lon=2.5, src_country="SG")


def test_snapshot_returns_serialized_events_oldest_first():
    r = Replay()
    r.add(_ev(100.0))
    r.add(_ev(101.0))

    snap = r.snapshot(now=102.0)

    assert [json.loads(s)["t"] for s in snap] == [100_000, 101_000]


def test_snapshot_drops_events_older_than_the_window():
    r = Replay(window_seconds=900.0)
    r.add(_ev(1000.0))
    r.add(_ev(1800.0))

    snap = r.snapshot(now=1900.0)

    assert [json.loads(s)["t"] for s in snap] == [1_800_000]
    assert len(r) == 1          # expired entry is evicted, not merely filtered


def test_buffer_is_bounded_by_count():
    r = Replay(max_events=3)
    for i in range(10):
        r.add(_ev(100.0 + i))

    assert len(r) == 3
    assert [json.loads(s)["t"] for s in r.snapshot(now=110.0)] == [107_000, 108_000, 109_000]


def test_add_never_raises_on_a_bad_event():
    class Broken:
        ts = 1.0

        def to_wire(self):
            raise ValueError("boom")

    r = Replay()
    r.add(Broken())          # must not propagate -- on_event's live path comes first

    assert len(r) == 0


def test_default_window_is_one_minute():
    """A kiosk reload used to receive the whole 15-minute window at once --
    thousands of events -- and the renderer's 220-arc pool churned hard for
    several seconds before settling. One minute is enough context to show the
    wall is live without that burst."""
    r = Replay()
    for i in range(10):
        r.add(_ev(1000.0 + i * 10))             # 1000..1090

    # now = 1100: only events at 1041..1100 are inside a 60s window.
    assert len(r.snapshot(now=1100.0)) == 5


def test_default_capacity_still_covers_a_full_minute_at_the_live_rate():
    """The count bound must not bite before the age bound at ~57 events/sec,
    or the window silently becomes shorter than it claims."""
    from netviz.replay import Replay

    r = Replay()
    assert r._items.maxlen >= 60 * 57
