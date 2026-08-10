import json
import threading

import pytest
from netviz.events import Event
from netviz.store import Store, event_to_point


class OkWriter:
    def __init__(self):
        self.written = []

    def write(self, points):
        self.written.extend(points)


class FailWriter:
    def write(self, points):
        raise ConnectionError("influx down")


def _ev(i=0):
    return Event(ts=float(i), kind="flow", src_ip="203.0.113.9",
                 dst_ip="192.168.0.50", bytes=i, proto=6,
                 src_lat=55.75, src_lon=37.62, src_country="RU")


def test_flush_writes_buffered_events(tmp_path):
    w = OkWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    s.add(_ev(1))
    assert s.flush() is True
    assert len(w.written) == 1
    assert s.buffered == 0


def test_write_failure_keeps_events_and_marks_unhealthy(tmp_path):
    s = Store(FailWriter(), str(tmp_path / "buf.jsonl"))
    s.add(_ev(1))
    assert s.flush() is False
    assert s.buffered == 1
    assert s.healthy is False


def test_buffer_is_bounded_and_drops_oldest(tmp_path):
    s = Store(FailWriter(), str(tmp_path / "buf.jsonl"), max_buffer=3)
    for i in range(5):
        s.add(_ev(i))
    assert s.buffered == 3
    assert [p["fields"]["bytes"] for p in s.pending()] == [2, 3, 4]


def test_recovery_drains_the_buffer(tmp_path):
    path = str(tmp_path / "buf.jsonl")
    s = Store(FailWriter(), path)
    for i in range(3):
        s.add(_ev(i))
    s.flush()
    ok = OkWriter()
    s2 = Store(ok, path)
    assert s2.buffered == 3
    assert s2.flush() is True
    assert len(ok.written) == 3
    assert s2.healthy is True


def test_point_shape_carries_country_as_tag(tmp_path):
    w = OkWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    s.add(_ev(7))
    s.flush()
    p = w.written[0]
    assert p["measurement"] == "netviz"
    assert p["tags"]["src_country"] == "RU"
    assert p["tags"]["kind"] == "flow"
    assert p["fields"]["src_lat"] == 55.75


def test_persist_failure_does_not_raise_and_marks_unhealthy(tmp_path):
    # Parent path is a regular file, not a directory, so os.makedirs()
    # inside _persist() raises OSError. flush() must swallow it, not
    # propagate it into the live path.
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x")
    bad_path = str(blocker / "buf.jsonl")

    s = Store(OkWriter(), bad_path)
    s.add(_ev(1))
    result = s.flush()

    assert result is False
    assert s.healthy is False


def test_load_tolerates_invalid_utf8_and_recovers_valid_line(tmp_path):
    path = tmp_path / "buf.jsonl"
    good = json.dumps(event_to_point(_ev(9)))
    with open(path, "wb") as fh:
        fh.write(b"\xff\xfe not valid utf-8 at all\n")
        fh.write(good.encode() + b"\n")

    s = Store(OkWriter(), str(path))

    assert s.buffered == 1
    assert s.pending()[0]["fields"]["bytes"] == 9


def test_point_carries_destination_coordinates(tmp_path):
    w = OkWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    ev = _ev(4)
    ev.dst_lat, ev.dst_lon, ev.dst_country = 51.5, -0.1, "GB"
    s.add(ev)
    s.flush()
    p = w.written[0]
    assert p["fields"]["dst_lat"] == 51.5
    assert p["fields"]["dst_lon"] == -0.1


def test_point_defaults_destination_coordinates_to_zero_when_missing(tmp_path):
    w = OkWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    s.add(_ev(5))  # no dst_lat/dst_lon set
    s.flush()
    p = w.written[0]
    assert p["fields"]["dst_lat"] == 0.0
    assert p["fields"]["dst_lon"] == 0.0


class CountingWriter:
    """Counts how many separate write() calls flush() makes, to prove a
    big backlog drains in one flush() invocation via multiple internal
    batches rather than needing one flush() call per 200-point batch."""

    def __init__(self):
        self.calls = 0
        self.written = []

    def write(self, points):
        self.calls += 1
        self.written.extend(points)


def test_flush_drains_thousands_of_events_in_one_cycle(tmp_path):
    w = CountingWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    for i in range(3000):
        s.add(_ev(i))
    assert s.buffered == 3000

    assert s.flush() is True

    assert s.buffered == 0                 # fully drained by ONE flush() call
    assert len(w.written) == 3000
    assert w.calls > 1                     # done via multiple 200-point batches


def test_flush_max_points_bounds_a_single_cycle(tmp_path):
    w = CountingWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"))
    for i in range(500):
        s.add(_ev(i))

    assert s.flush(max_points=200) is True

    assert len(w.written) == 200
    assert s.buffered == 300               # rest waits for the next flush() call


def test_load_skips_non_point_json_to_avoid_head_of_line_poisoning(tmp_path):
    path = tmp_path / "buf.jsonl"
    good = json.dumps(event_to_point(_ev(3)))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps([1, 2, 3]) + "\n")   # valid JSON, not a point
        fh.write(json.dumps(42) + "\n")          # valid JSON, not a point
        fh.write(good + "\n")

    s = Store(OkWriter(), str(path))

    assert s.buffered == 1
    assert s.pending()[0]["fields"]["bytes"] == 3


# --- Concurrency: add() from the event loop vs. flush() in a worker thread -
#
# The real bug (reproduced against this exact Store): _persist() iterates
# self._buf with a plain `for` in a worker thread while add() appends to it
# from another thread. A deque records a mutation counter and a `for` over
# it raises RuntimeError the moment that counter changes mid-iteration --
# the GIL switches between opcodes, not between "safe points", so this is
# not a rare timing fluke once the buffer is a few thousand points and
# add() is hammering concurrently. These tests exercise that directly
# against a real Store with a real background thread, not a sequential
# call-both-methods smoke test, which would never see the race at all.

def test_concurrent_add_and_flush_raises_no_exception(tmp_path):
    w = OkWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"), max_buffer=50_000, batch=100)

    # Seed a large backlog first -- the reproduction needs enough points
    # that _persist()'s file-write loop takes long enough for add() to land
    # in the middle of it. 9,000 matches the size that reproduced the
    # RuntimeError against the unlocked Store.
    for i in range(9_000):
        s.add(_ev(i))

    stop = threading.Event()
    errors: list[BaseException] = []

    def adder():
        i = 9_000
        while not stop.is_set():
            try:
                s.add(_ev(i))
            except BaseException as exc:  # noqa: BLE001 - must capture everything
                errors.append(exc)
                return
            i += 1

    def flusher():
        for _ in range(30):
            try:
                s.flush()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
                return

    at = threading.Thread(target=adder)
    ft = threading.Thread(target=flusher)
    at.start()
    ft.start()
    ft.join(timeout=30)
    stop.set()
    at.join(timeout=30)

    assert errors == [], f"add()/flush() raised under concurrency: {errors!r}"


def test_concurrent_add_and_flush_no_duplicates_or_lost_points(tmp_path):
    # max_buffer is set well above the total number of points ever added,
    # so maxlen eviction never enters into it -- any point missing from
    # (written + still-buffered) was lost by the drain/pop logic itself,
    # and any point appearing twice in `written` was double-drained by two
    # overlapping flush() calls.
    w = OkWriter()
    total = 6_000
    s = Store(w, str(tmp_path / "buf.jsonl"), max_buffer=total + 1_000, batch=50)

    next_id = {"i": 0}
    id_lock = threading.Lock()

    def claim_id():
        with id_lock:
            if next_id["i"] >= total:
                return None
            i = next_id["i"]
            next_id["i"] += 1
            return i

    def adder():
        while True:
            i = claim_id()
            if i is None:
                return
            s.add(_ev(i))

    stop_flushing = threading.Event()

    def flusher():
        while not stop_flushing.is_set():
            s.flush()

    adders = [threading.Thread(target=adder) for _ in range(4)]
    ft = threading.Thread(target=flusher)
    ft.start()
    for t in adders:
        t.start()
    for t in adders:
        t.join(timeout=30)
    stop_flushing.set()
    ft.join(timeout=30)

    # Drain whatever is left after the concurrent phase ends.
    for _ in range(10):
        if s.buffered == 0:
            break
        s.flush()

    written_ids = [p["fields"]["bytes"] for p in w.written]
    remaining_ids = [p["fields"]["bytes"] for p in s.pending()]

    assert len(written_ids) == len(set(written_ids)), "duplicate write detected"
    assert len(remaining_ids) == len(set(remaining_ids)), "duplicate item left in buffer"
    assert sorted(written_ids + remaining_ids) == list(range(total)), (
        "points lost or duplicated across written+buffered"
    )


def test_flush_is_reentrant_safe_second_call_does_not_double_drain(tmp_path):
    """flush_seconds (10s) can be shorter than the worker-thread timeout
    (15s), so the periodic timer can call flush() again while a slow
    drain from a prior call is still running. A second concurrent
    flush() must not re-drain the buffer or write duplicates -- it
    should return immediately instead."""

    release_writer = threading.Event()
    entered_write = threading.Event()

    class SlowWriter:
        def __init__(self):
            self.write_calls = 0
            self.written = []

        def write(self, points):
            self.write_calls += 1
            entered_write.set()
            release_writer.wait(timeout=10)
            self.written.extend(points)

    w = SlowWriter()
    s = Store(w, str(tmp_path / "buf.jsonl"), max_buffer=1000, batch=200)
    for i in range(200):
        s.add(_ev(i))

    results = []

    def first_flush():
        results.append(("first", s.flush()))

    t1 = threading.Thread(target=first_flush)
    t1.start()
    assert entered_write.wait(timeout=10), "first flush never reached the writer"

    # Second call while the first is blocked inside writer.write(): must
    # not block and must not drain anything itself.
    second_result = s.flush()
    results.append(("second", second_result))

    release_writer.set()
    t1.join(timeout=10)

    assert w.write_calls == 1, "second flush() drained/wrote concurrently with the first"
    assert len(w.written) == 200
    assert len(set(p["fields"]["bytes"] for p in w.written)) == 200
