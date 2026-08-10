import pytest
from netviz.health import Health, RatioAlert

THRESH = {"netflow": 60.0, "blocks": 21600.0}


def test_feed_never_seen_is_stale_immediately():
    h = Health(THRESH)
    assert h.evaluate(now=1000.0) == [("netflow", "stale"), ("blocks", "stale")]


def test_transition_is_emitted_once_not_repeatedly():
    h = Health(THRESH)
    h.evaluate(now=1000.0)
    assert h.evaluate(now=1001.0) == []


def test_fresh_feed_is_not_stale():
    h = Health(THRESH)
    h.saw("netflow", now=1000.0)
    h.saw("blocks", now=1000.0)
    assert h.evaluate(now=1030.0) == []


def test_feed_goes_stale_after_threshold():
    h = Health(THRESH)
    h.saw("netflow", now=1000.0)
    h.saw("blocks", now=1000.0)
    assert h.evaluate(now=1061.0) == [("netflow", "stale")]


def test_recovery_is_emitted_once():
    h = Health(THRESH)
    h.saw("netflow", now=1000.0)
    h.saw("blocks", now=1000.0)
    h.evaluate(now=1061.0)
    h.saw("netflow", now=1062.0)
    assert h.evaluate(now=1062.0) == [("netflow", "recovered")]
    assert h.evaluate(now=1063.0) == []


def test_status_reports_last_good_and_age():
    h = Health(THRESH)
    h.saw("netflow", now=1000.0)
    st = h.status(now=1010.0)
    assert st["netflow"]["ok"] is True
    assert st["netflow"]["last_good"] == 1000.0
    assert st["netflow"]["age"] == pytest.approx(10.0)


def test_status_age_uses_is_not_none_not_truthiness():
    # last_good of exactly 0.0 is falsy but must still report a real age,
    # not None -- a truthiness check on last_good would misreport this.
    h = Health(THRESH)
    h.saw("netflow", now=0.0)
    st = h.status(now=5.0)
    assert st["netflow"]["last_good"] == 0.0
    assert st["netflow"]["age"] == pytest.approx(5.0)


# --- RatioAlert: GeoIP miss-rate alert (design spec 6.2/6.3) ---------------
#
# evaluate() is fed cumulative-since-boot counters (same shape as
# enricher.stats), but judges the ratio over the window since the
# *previous* call -- see health.py's RatioAlert docstring. Each test below
# passes cumulative values across calls; the window a given call is
# judged on is the delta from the previous call's cumulative values (or
# from zero, for the first call).

def test_ratio_alert_no_transition_below_min_samples():
    r = RatioAlert("geoip", threshold=0.20, min_samples=50)
    # First window: 45 attempts, 90% miss rate -- but under the sample
    # floor, so a handful of early misses must not trip the alert.
    assert r.evaluate(misses=40, hits=5) == []


def test_ratio_alert_fires_once_on_entry():
    r = RatioAlert("geoip", threshold=0.20, min_samples=10)
    assert r.evaluate(misses=1, hits=9) == []                     # window: 1/10 = 10%, ok
    # window delta: misses +4, hits +6 -> 4/10 = 40%, breach
    assert r.evaluate(misses=5, hits=15) == [("geoip", "stale")]
    # window delta: misses +4, hits +6 -> still 40%, still breached, no repeat
    assert r.evaluate(misses=9, hits=21) == []


def test_ratio_alert_fires_once_on_recovery():
    r = RatioAlert("geoip", threshold=0.20, min_samples=10)
    r.evaluate(misses=5, hits=5)                                      # window: 50%, breach
    # window delta: misses +0, hits +40 -> 0/40 = 0%, recovers
    assert r.evaluate(misses=5, hits=45) == [("geoip", "recovered")]
    # window delta: 0 attempts -- under the sample floor, no repeat
    assert r.evaluate(misses=5, hits=45) == []


def test_ratio_alert_exactly_at_threshold_is_not_a_breach():
    r = RatioAlert("geoip", threshold=0.20, min_samples=10)
    assert r.evaluate(misses=2, hits=8) == []  # window: exactly 20%, not "exceeds"


def test_ratio_alert_breaks_after_a_long_healthy_history():
    """The bug this fixes: a lifetime ratio fed by weeks of healthy
    operation can't be moved past threshold by a fresh break for days,
    because the accumulated denominator swamps the new numerator. A
    windowed rate catches it in the very next sample."""
    r = RatioAlert("geoip", threshold=0.20, min_samples=50)
    # Weeks of healthy operation baked into the starting cumulative
    # counters: 99,900 hits, 100 misses (0.1% lifetime).
    assert r.evaluate(misses=100, hits=99_900) == []
    # geoip breaks entirely for the next window: +5,000 misses, +0 hits.
    # Lifetime rate would still read 5,100 / 105,000 = 4.9%, well under
    # the 20% threshold -- but the window rate is 100%.
    assert r.evaluate(misses=5_100, hits=99_900) == [("geoip", "stale")]


def test_ratio_alert_early_spike_clears_and_does_not_latch():
    """The other half of the bug: one bad window right after boot must
    not permanently latch the alert once real traffic starts flowing
    healthily -- a lifetime ratio can never fully recover from a bad
    enough start; a windowed one clears on the very next good window."""
    r = RatioAlert("geoip", threshold=0.20, min_samples=10)
    # Early spike: first window is 8/10 = 80% misses.
    assert r.evaluate(misses=8, hits=2) == [("geoip", "stale")]
    # Long healthy window follows: delta +1 miss, +1,000 hits -> ~0.1%.
    assert r.evaluate(misses=9, hits=1_002) == [("geoip", "recovered")]
    # Further healthy windows stay clear, no repeat alerts.
    assert r.evaluate(misses=10, hits=2_002) == []
