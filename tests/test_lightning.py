import json

import pytest

from netviz import lightning


# Three real lines, copied byte-for-byte from the live 20260815_0650 bucket.
# Note what they are NOT: valid JSON. The timestamp is unquoted and every line
# ends in a comma with no array around it.
REAL_LINES = (
    '{"time":2026-08-15T06:50:00,"lat":35.544954,"lon":-73.302341,"src":2,"srv":1},\n'
    '{"time":2026-08-15T06:53:04,"lat":-12.100000,"lon":130.500000,"src":2,"srv":1},\n'
    '{"time":2026-08-15T06:59:59,"lat":0.000000,"lon":-0.500000,"src":2,"srv":1},\n'
)


def test_the_feed_is_not_json():
    """If this ever starts passing, the upstream changed and parse() can simplify.

    It is a test rather than a comment because the regex in parse() looks like
    something to 'clean up' with the json module, and this is the evidence that
    doing so breaks the collector.
    """
    with pytest.raises(json.JSONDecodeError):
        json.loads(REAL_LINES)
    with pytest.raises(json.JSONDecodeError):
        json.loads(REAL_LINES.splitlines()[0])


def test_parse_reads_second_within_bucket():
    strokes, skipped = lightning.parse(REAL_LINES)
    assert skipped == 0
    assert strokes == [
        (0, 35.544954, -73.302341),
        (184, -12.1, 130.5),
        (599, 0.0, -0.5),
    ]


def test_parse_skips_junk_without_raising():
    text = REAL_LINES + "not a record at all\n" + '{"time":oops,"lat":1,"lon":2},\n'
    strokes, skipped = lightning.parse(text)
    assert len(strokes) == 3
    assert skipped == 2


def test_parse_returns_strokes_sorted_by_second():
    text = (
        '{"time":2026-08-15T06:59:00,"lat":1.0,"lon":2.0,"src":2,"srv":1},\n'
        '{"time":2026-08-15T06:50:30,"lat":3.0,"lon":4.0,"src":2,"srv":1},\n'
    )
    strokes, _ = lightning.parse(text)
    assert [s[0] for s in strokes] == [30, 540]


def test_bucket_name_floors_to_ten_minutes():
    start = lightning.bucket_start("20260815_0650")
    assert lightning.bucket_name(start) == "20260815_0650"          # on the boundary
    assert lightning.bucket_name(start + 457) == "20260815_0650"    # mid-bucket
    assert lightning.bucket_name(start + 599) == "20260815_0650"    # last second
    assert lightning.bucket_name(start + 600) == "20260815_0700"    # next bucket


def test_bucket_start_round_trips():
    for name in ("20260815_0000", "20260815_0650", "20261231_2350"):
        assert lightning.bucket_name(lightning.bucket_start(name)) == name


def test_latest_ready_never_returns_a_bucket_that_is_not_published():
    start = lightning.bucket_start("20260815_0700")
    # Exactly on the boundary: the 06:50 bucket published at 07:21, so at 07:00
    # the newest READY bucket is 06:20 -- 07:00 minus the 32 minute lag.
    assert lightning.latest_ready(start) == "20260815_0620"
    # One second before its own publish deadline, 06:50 is still not ready.
    assert lightning.latest_ready(start + 21 * 60 + 59) == "20260815_0640"
    # One second after, it is.
    assert lightning.latest_ready(start + 22 * 60 + 1) == "20260815_0650"


def test_sample_thins_evenly_and_keeps_both_ends():
    strokes = [(i % 600, float(i), float(-i)) for i in range(20000)]
    strokes.sort(key=lambda s: s[0])
    out = lightning.sample(strokes, 6000)
    assert len(out) == 6000
    assert out[0] == strokes[0]
    assert out[-1] == strokes[-1]
    assert [s[0] for s in out] == sorted(s[0] for s in out)


def test_sample_leaves_a_small_bucket_alone():
    strokes = [(i, 1.0, 2.0) for i in range(10)]
    assert lightning.sample(strokes, 6000) == strokes


def test_cache_before_any_fetch_is_empty_but_not_absent():
    cache = lightning.LightningCache()
    state = cache.state(lightning.bucket_start("20260815_0700"))
    assert state["bucket"] is None
    assert state["age"] is None
    assert state["count"] == 0
    assert state["strokes"] == []


def test_cache_rounds_coordinates_to_three_decimals():
    cache = lightning.LightningCache()
    cache.update("20260815_0650", [(0, 35.544954, -73.302341)])
    state = cache.state(lightning.bucket_start("20260815_0650") + 60)
    assert state["strokes"] == [[0, 35.545, -73.302]]
    assert state["bucket"] == "2026-08-15T06:50:00Z"
    assert state["age"] == 60.0
    assert state["count"] == 1


def test_refresh_installs_the_newest_ready_bucket():
    cache = lightning.LightningCache()
    seen = []

    def fetcher(name, timeout=30.0):
        seen.append(name)
        return [(5, 1.0, 2.0)]

    now = lightning.bucket_start("20260815_0700") + 22 * 60
    assert lightning.refresh(cache, now=now, fetcher=fetcher) is True
    assert seen == ["20260815_0650"]
    assert cache.state(now)["bucket"] == "2026-08-15T06:50:00Z"


def test_refresh_does_not_refetch_the_bucket_it_already_has():
    cache = lightning.LightningCache()
    calls = []

    def fetcher(name, timeout=30.0):
        calls.append(name)
        return [(5, 1.0, 2.0)]

    now = lightning.bucket_start("20260815_0700") + 22 * 60
    lightning.refresh(cache, now=now, fetcher=fetcher)
    assert lightning.refresh(cache, now=now + 30, fetcher=fetcher) is False
    assert calls == ["20260815_0650"]


def test_refresh_survives_a_failed_fetch_and_keeps_the_old_bucket():
    cache = lightning.LightningCache()
    now = lightning.bucket_start("20260815_0700") + 22 * 60
    lightning.refresh(cache, now=now, fetcher=lambda name, timeout=30.0: [(5, 1.0, 2.0)])
    before = cache.state(now)

    def dead(name, timeout=30.0):
        return None

    later = now + lightning.BUCKET_SECONDS
    assert lightning.refresh(cache, now=later, fetcher=dead) is False
    assert cache.state(later)["bucket"] == before["bucket"]


def test_refresh_caps_a_huge_bucket():
    cache = lightning.LightningCache()
    huge = [(i % 600, float(i % 90), float(i % 180)) for i in range(20000)]
    huge.sort(key=lambda s: s[0])
    now = lightning.bucket_start("20260815_0700") + 22 * 60
    lightning.refresh(cache, now=now, fetcher=lambda name, timeout=30.0: huge)
    assert cache.state(now)["count"] == lightning.MAX_STROKES


def test_next_poll_delay_lands_after_the_publish_deadline():
    start = lightning.bucket_start("20260815_0700")
    for offset in range(0, 600, 37):
        delay = lightning.next_poll_delay(start + offset)
        assert 0 < delay <= lightning.BUCKET_SECONDS
        landed = (start + offset + delay) % lightning.BUCKET_SECONDS
        # Fires at 2 minutes past a boundary: 32 minutes of lag is three whole
        # buckets plus two minutes, so the useful phase is 120s.
        assert abs(landed - 120) < 1.0
