import json

from netviz.events import Event
from netviz.replay import Replay


class FakeClock:
    """The window is measured on the collector's own monotonic clock, not on
    the event's ts -- a flow's ts is the ROUTER's export time and a drifted
    router must not decide what a fresh kiosk sees. Driving that clock by hand
    is what these tests need; the ts values below are deliberately unrelated
    to it, which is the property under test."""

    def __init__(self, t: float = 0.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


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
    clock = FakeClock(1000.0)
    r = Replay(window_seconds=900.0, clock=clock)
    r.add(_ev(1000.0))
    clock.t = 1800.0
    r.add(_ev(1800.0))
    clock.t = 1900.0

    snap = r.snapshot()

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
    clock = FakeClock(1000.0)
    r = Replay(clock=clock)
    for i in range(10):
        clock.t = 1000.0 + i * 10               # arrivals at 1000..1090
        r.add(_ev(1000.0 + i * 10))
    clock.t = 1100.0

    # only arrivals at 1041..1100 are inside a 60s window.
    assert len(r.snapshot()) == 5


def test_default_capacity_still_covers_a_full_minute_at_the_live_rate():
    """The count bound must not bite before the age bound at ~57 events/sec,
    or the window silently becomes shorter than it claims."""
    from netviz.replay import Replay

    r = Replay()
    assert r._items.maxlen >= 60 * 57


def test_the_window_ignores_the_routers_clock():
    """The bug this guards: a flow's ts is the IPFIX header's export time, so
    a router whose clock runs a day behind stamped every flow as long expired
    and a freshly connected kiosk backfilled nothing but blocks -- which carry
    a local timestamp and so survived. Arrival time is what decides."""
    clock = FakeClock(5_000.0)
    r = Replay(window_seconds=60.0, clock=clock)
    r.add(_ev(5_000.0 - 86_400))        # router a day slow
    r.add(_ev(5_000.0 + 86_400))        # and a day fast

    assert len(r.snapshot()) == 2


def test_a_broken_event_leaves_no_timestamp_behind():
    class Broken:
        ts = 1.0

        def to_wire(self):
            raise ValueError("boom")

    r = Replay()
    r.add(Broken())
    assert r.snapshot() == []
