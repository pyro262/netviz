import json
import urllib.error

import pytest

from netviz import aurora


class _Resp:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _noaa(rows):
    """The header-row + arrays form some SWPC endpoints use."""
    return json.dumps([["time_tag", "Kp", "a_running", "station_count"]] + rows).encode()


def _noaa_objects(kps):
    """The form the planetary K-index endpoint actually serves, verified
    against the live feed on 2026-08-08."""
    return json.dumps([
        {"time_tag": "2026-08-09T00:00:00", "Kp": k, "a_running": 12,
         "station_count": 8}
        for k in kps
    ]).encode()


def test_latest_kp_reads_the_live_object_feed(monkeypatch):
    monkeypatch.setattr(aurora.urllib.request, "urlopen",
                        lambda *a, **k: _Resp(_noaa_objects([1.0, 2.67])))

    assert aurora.fetch_kp() == pytest.approx(2.67)


def test_a_null_newest_object_falls_back_to_the_previous_one(monkeypatch):
    monkeypatch.setattr(aurora.urllib.request, "urlopen",
                        lambda *a, **k: _Resp(_noaa_objects([3.33, None])))

    assert aurora.fetch_kp() == pytest.approx(3.33)


def test_latest_kp_reads_the_most_recent_row(monkeypatch):
    rows = [
        ["2026-08-08 20:00:00", "2.33", "7", "8"],
        ["2026-08-08 21:00:00", "4.67", "27", "8"],
    ]
    monkeypatch.setattr(aurora.urllib.request, "urlopen", lambda *a, **k: _Resp(_noaa(rows)))

    assert aurora.fetch_kp() == pytest.approx(4.67)


def test_a_network_failure_returns_none_rather_than_raising(monkeypatch):
    """The globe must keep drawing when NOAA is unreachable; the cache decides
    what to show, not an exception in the fetch."""
    def boom(*a, **k):
        raise urllib.error.URLError("no route")

    monkeypatch.setattr(aurora.urllib.request, "urlopen", boom)

    assert aurora.fetch_kp() is None


def test_malformed_json_returns_none(monkeypatch):
    monkeypatch.setattr(aurora.urllib.request, "urlopen", lambda *a, **k: _Resp(b"<html>"))

    assert aurora.fetch_kp() is None


def test_a_feed_with_only_a_header_returns_none(monkeypatch):
    monkeypatch.setattr(aurora.urllib.request, "urlopen", lambda *a, **k: _Resp(_noaa([])))

    assert aurora.fetch_kp() is None


def test_an_unparseable_kp_value_is_skipped_for_the_last_good_one(monkeypatch):
    rows = [["t", "3.00", "", ""], ["t", "null", "", ""]]
    monkeypatch.setattr(aurora.urllib.request, "urlopen", lambda *a, **k: _Resp(_noaa(rows)))

    assert aurora.fetch_kp() == pytest.approx(3.0)


def test_out_of_range_values_are_rejected(monkeypatch):
    # Kp is a 0-9 scale. Anything else means the feed changed shape.
    rows = [["t", "42", "", ""]]
    monkeypatch.setattr(aurora.urllib.request, "urlopen", lambda *a, **k: _Resp(_noaa(rows)))

    assert aurora.fetch_kp() is None


def test_cache_keeps_the_last_good_value_when_a_refresh_fails():
    cache = aurora.KpCache(ttl=100.0)
    cache.update(4.0, now=1000.0)
    cache.update(None, now=1100.0)          # failed refresh

    state = cache.state(now=1100.0)
    assert state["kp"] == pytest.approx(4.0)
    assert state["stale"] is True           # older than the ttl now


def test_cache_reports_fresh_inside_the_ttl():
    cache = aurora.KpCache(ttl=100.0)
    cache.update(4.0, now=1000.0)

    assert cache.state(now=1050.0)["stale"] is False


def test_cache_with_no_value_yet_reports_none_not_zero():
    """Kp 0 is a real, very quiet sky. 'No data' must not be drawn as that."""
    cache = aurora.KpCache(ttl=100.0)

    state = cache.state(now=0.0)
    assert state["kp"] is None
    assert state["stale"] is True


def test_oval_boundary_moves_equatorward_as_kp_rises():
    # The auroral oval's equatorward edge is near 66 degrees magnetic latitude
    # when quiet and reaches the mid-50s in a strong storm.
    quiet = aurora.oval_boundary(0)
    storm = aurora.oval_boundary(7)

    assert 64 < quiet <= 67
    assert 52 < storm < 60
    assert storm < quiet


def test_poll_delay_lands_just_after_the_next_publish_boundary():
    """NOAA publishes planetary Kp on 3-hour boundaries. Polling every 3 hours
    from an arbitrary start would sit up to 3 hours behind the data; aligning
    to the boundary keeps the wall within minutes of it."""
    import datetime as dt

    # 01:10 UTC -> next boundary is 03:00, plus the settle offset.
    now = dt.datetime(2026, 8, 9, 1, 10, tzinfo=dt.timezone.utc).timestamp()
    delay = aurora.next_poll_delay(now, offset=240.0)

    fires_at = dt.datetime.fromtimestamp(now + delay, dt.timezone.utc)
    assert (fires_at.hour, fires_at.minute) == (3, 4)


def test_poll_delay_just_after_a_boundary_waits_for_the_next_one():
    import datetime as dt

    now = dt.datetime(2026, 8, 9, 3, 5, tzinfo=dt.timezone.utc).timestamp()
    delay = aurora.next_poll_delay(now, offset=240.0)

    fires_at = dt.datetime.fromtimestamp(now + delay, dt.timezone.utc)
    assert (fires_at.hour, fires_at.minute) == (6, 4)


def test_poll_delay_is_never_zero_or_negative():
    """A zero delay would spin the poller into a hot loop against NOAA."""
    import datetime as dt

    for minute in (0, 3, 4, 5, 59):
        now = dt.datetime(2026, 8, 9, 3, minute, tzinfo=dt.timezone.utc).timestamp()
        assert aurora.next_poll_delay(now, offset=240.0) > 0


def test_poll_delay_never_exceeds_one_period():
    import datetime as dt

    for hour in range(24):
        now = dt.datetime(2026, 8, 9, hour, 30, tzinfo=dt.timezone.utc).timestamp()
        assert aurora.next_poll_delay(now, offset=240.0) <= 3 * 3600


def test_the_ttl_outlasts_the_publish_cadence():
    """A ttl shorter than the 3-hour publication interval marks every reading
    stale before its replacement exists, which dims the aurora permanently."""
    assert aurora.DEFAULT_TTL > aurora.POLL_PERIOD


def test_a_value_is_still_fresh_just_before_the_next_publication():
    cache = aurora.KpCache()
    cache.update(5.0, now=0.0)

    assert cache.state(now=aurora.POLL_PERIOD - 1)["stale"] is False


def test_two_missed_publications_do_go_stale():
    cache = aurora.KpCache()
    cache.update(5.0, now=0.0)

    assert cache.state(now=2 * aurora.POLL_PERIOD + 1)["stale"] is True
