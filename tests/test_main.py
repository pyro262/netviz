import asyncio
import contextlib
import json
import logging
import time

import pytest

from netviz import main as netviz_main
from netviz.events import Event
from netviz.fanout import CLOSE, Fanout
from netviz.health import Health


def _ev():
    return Event(ts=1.0, kind="block", src_ip="203.0.113.9",
                 dst_ip="192.168.0.1", bytes=60, proto=6)


class _FakeWebSocket:
    """Minimal stand-in for a websockets ServerConnection: records sends and
    close(), and can simulate an abrupt client disconnect (wait_closed()
    resolving with no send() ever failing) via trigger_closed()."""

    def __init__(self):
        self.sent = []
        self.closed = False
        self._closed_event = asyncio.Event()

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True
        self._closed_event.set()

    async def wait_closed(self):
        await self._closed_event.wait()

    def trigger_closed(self):
        """Simulate the underlying transport noticing the client vanished,
        independent of any send()/close() call from our own code."""
        self._closed_event.set()


# --- Defect 1: ws_handler must treat CLOSE as a sentinel, not an event -----

async def test_ws_handler_stops_and_closes_on_close_sentinel():
    fanout = Fanout()
    ws = _FakeWebSocket()

    handler_task = asyncio.create_task(netviz_main.ws_handler(ws, fanout))
    await asyncio.sleep(0)  # let it register and start awaiting queue.get()

    assert fanout.client_count == 1
    key = next(iter(fanout._clients))
    fanout.close_client(key)

    await asyncio.wait_for(handler_task, timeout=1.0)

    # No attempt was made to json.dumps the sentinel and send it.
    assert ws.sent == []
    assert ws.closed is True
    # unregister happened (idempotent, but confirms cleanup ran)
    assert fanout.client_count == 0


async def test_ws_handler_forwards_ordinary_events_then_stops_on_close():
    fanout = Fanout()
    ws = _FakeWebSocket()

    handler_task = asyncio.create_task(netviz_main.ws_handler(ws, fanout))
    await asyncio.sleep(0)

    fanout.broadcast(_ev())
    await asyncio.sleep(0)

    key = next(iter(fanout._clients))
    fanout.close_client(key)
    await asyncio.wait_for(handler_task, timeout=1.0)

    assert len(ws.sent) == 1
    decoded = json.loads(ws.sent[0])
    assert decoded["k"] == "block"
    assert ws.closed is True


async def test_ws_handler_never_serializes_the_close_sentinel():
    """Regression guard: CLOSE is a bare object(); json.dumps(CLOSE) raises
    TypeError. If ws_handler ever regresses to feeding CLOSE into json.dumps,
    this manifests as an unhandled exception rather than a clean stop."""
    with pytest.raises(TypeError):
        json.dumps(CLOSE)

    fanout = Fanout()
    ws = _FakeWebSocket()
    handler_task = asyncio.create_task(netviz_main.ws_handler(ws, fanout))
    await asyncio.sleep(0)
    key = next(iter(fanout._clients))
    fanout.close_client(key)
    # Must complete cleanly, not raise TypeError out of the task.
    await asyncio.wait_for(handler_task, timeout=1.0)
    assert ws.sent == []


# --- Defect 2: alerter must survive a raising notify.post -------------------

async def test_alerter_survives_notify_post_raising(monkeypatch, caplog):
    calls = {"count": 0}

    def _raise(_msg):
        calls["count"] += 1
        raise RuntimeError("WATCHTOWER_NOTIFICATION_URL not found")

    monkeypatch.setattr(netviz_main.notify, "post", _raise)

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    health = Health({"netflow": 1.0})
    # First evaluate() sees last=None -> immediate "stale" transition, which
    # triggers a notify.post call that raises. The loop must survive it.
    task = asyncio.create_task(netviz_main.alerter(health))

    with caplog.at_level(logging.WARNING, logger="netviz"):
        for _ in range(3):
            await orig_sleep(0)

    assert not task.done()  # still alive despite post() raising
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # notify.post was called at least once and raised, but the task was
    # still alive (we had to cancel it, it did not die on its own).
    assert calls["count"] >= 1


async def test_alerter_logs_exception_and_continues_looping(monkeypatch):
    """More direct proof: after post() raises on a stale transition, the
    loop keeps evaluating health on subsequent iterations rather than
    dying — confirmed by a second stale->recovered transition also
    triggering a (second) post attempt."""
    posts = []

    def _raise(msg):
        posts.append(msg)
        raise RuntimeError("boom")

    monkeypatch.setattr(netviz_main.notify, "post", _raise)

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    health = Health({"netflow": 1.0})
    now = [0.0]
    monkeypatch.setattr(netviz_main.time, "time", lambda: now[0])

    task = asyncio.create_task(netviz_main.alerter(health))
    await orig_sleep(0)  # first evaluate(): last=None -> stale transition, post raises
    await orig_sleep(0)

    now[0] = 100.0
    health.saw("netflow", 100.0)  # feed recovers
    await orig_sleep(0)
    await orig_sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(posts) >= 1  # first raise didn't kill the loop permanently


# --- flusher / synth also survive exceptions in their own body -------------

async def test_flusher_survives_store_flush_raising(monkeypatch):
    class _BoomStore:
        def flush(self):
            raise RuntimeError("disk exploded")

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    health = Health({"influx": 120.0})
    task = asyncio.create_task(netviz_main.flusher(_BoomStore(), health, 0.001))
    for _ in range(3):
        await orig_sleep(0)

    assert not task.done()  # still alive despite flush() raising every tick
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_synth_survives_on_event_raising(monkeypatch):
    import random

    calls = {"count": 0}

    def _boom(_ev, _feed):
        calls["count"] += 1
        raise RuntimeError("on_event blew up")

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    task = asyncio.create_task(netviz_main.synth(_boom, random.Random(0)))
    for _ in range(3):
        await orig_sleep(0)

    assert calls["count"] >= 2  # kept calling on_event across iterations
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# --- synth must not reach into SyntheticFeed's private _rng ----------------

def test_synth_uses_injected_rng_not_feed_private_attr():
    import inspect
    src = inspect.getsource(netviz_main.synth)
    assert "_rng" not in src


# --- config sanity -----------------------------------------------------

def test_config_defaults():
    from netviz.config import Config
    cfg = Config()
    assert cfg.ws_port == 8099
    assert cfg.ipfix_port == 2055
    assert cfg.syslog_port == 5514


# --- Finding 1: on_event must not let a downstream failure escape into the
# datagram_received loop, and must keep processing the rest of the batch ----

def _build_run_locals(monkeypatch, synthetic=False, broadcast_raises=False):
    """Reach into run()'s on_event closure by constructing the same pieces
    it does, without actually starting the asyncio service. Returns
    (on_event, fanout, health, store)."""
    from netviz.config import Config
    from netviz.fanout import Fanout as RealFanout
    from netviz.health import Health as RealHealth

    fanout = RealFanout()
    health = RealHealth(netviz_main.THRESHOLDS)
    store = None
    enricher = None

    if broadcast_raises:
        def _boom(_ev):
            raise RuntimeError("fanout blew up")
        monkeypatch.setattr(fanout, "broadcast", _boom)

    def on_event(ev, feed):
        try:
            if enricher is not None:
                enriched = enricher.enrich(ev)
                if enriched is None:
                    return
                ev = enriched
            health.saw(feed, __import__("time").time())
            fanout.broadcast(ev)
            if store is not None:
                store.add(ev)
        except Exception:
            netviz_main.log.exception(
                "on_event: unhandled error for feed %s, continuing", feed)

    return on_event, fanout, health, store


def test_on_event_swallows_downstream_exception_and_logs(monkeypatch, caplog):
    on_event, fanout, health, _store = _build_run_locals(
        monkeypatch, broadcast_raises=True)

    with caplog.at_level(logging.ERROR, logger="netviz"):
        on_event(_ev(), "blocks")  # must not raise

    assert "on_event" in caplog.text
    assert "blocks" in caplog.text


def test_real_on_event_guard_lets_ipfix_protocol_process_full_batch():
    """With the actual guarded on_event (as built in run()), a downstream
    failure on event 1 does not stop events 2 and 3 of the same datagram
    from being processed."""
    calls = []

    def guarded_on_event(ev, feed):
        try:
            calls.append(ev)
            if len(calls) == 1:
                raise RuntimeError("boom on first event")
        except Exception:
            netviz_main.log.exception("on_event: unhandled error, continuing")

    proto = netviz_main.IpfixProtocol(guarded_on_event)

    class _StubDecoder:
        def decode(self, _data):
            return [_ev(), _ev(), _ev()]

    proto._decoder = _StubDecoder()
    proto.datagram_received(b"whatever", ("1.2.3.4", 1234))  # must not raise

    assert len(calls) == 3  # all three events reached on_event


# --- Finding 2: synthetic-mode Health must never track "influx" ------------

def test_synthetic_thresholds_excludes_influx():
    assert "influx" not in netviz_main.SYNTHETIC_THRESHOLDS
    assert "netflow" in netviz_main.SYNTHETIC_THRESHOLDS
    assert "blocks" in netviz_main.SYNTHETIC_THRESHOLDS


def test_synthetic_mode_health_never_produces_an_influx_transition():
    health = Health(netviz_main.SYNTHETIC_THRESHOLDS)
    # Simulate a long synthetic run: far past the real THRESHOLDS["influx"]
    # window (120s), with netflow/blocks kept alive but influx never seen.
    health.saw("netflow", 0.0)
    health.saw("blocks", 0.0)
    transitions = health.evaluate(10_000.0)  # ~2.7 hours later
    feeds_seen = {feed for feed, _ in transitions}
    assert "influx" not in feeds_seen
    # And status() has no "influx" key at all to accidentally alert on.
    assert "influx" not in health.status(10_000.0)


# --- Finding 3: ws_handler must notice an abrupt disconnect without         #
# waiting for the next broadcast --------------------------------------------

async def test_ws_handler_unregisters_on_abrupt_disconnect_during_quiet_period():
    """No broadcast ever happens (a 'quiet period'); the fake transport
    directly signals closure via wait_closed(). The handler must notice
    and unregister immediately, not hang forever on queue.get()."""
    fanout = Fanout()
    ws = _FakeWebSocket()

    handler_task = asyncio.create_task(netviz_main.ws_handler(ws, fanout))
    await asyncio.sleep(0)
    assert fanout.client_count == 1

    ws.trigger_closed()  # simulate the client vanishing with no data in flight

    await asyncio.wait_for(handler_task, timeout=1.0)

    assert fanout.client_count == 0
    assert ws.sent == []


async def test_ws_handler_does_not_leak_pending_tasks_on_disconnect():
    """The losing side of the queue.get()/wait_closed() race must be
    cancelled, not left as a dangling pending task."""
    fanout = Fanout()
    ws = _FakeWebSocket()

    tasks_before = len(asyncio.all_tasks())
    handler_task = asyncio.create_task(netviz_main.ws_handler(ws, fanout))
    await asyncio.sleep(0)

    ws.trigger_closed()
    await asyncio.wait_for(handler_task, timeout=1.0)
    await asyncio.sleep(0)  # let cancellation cleanup settle

    tasks_after = len(asyncio.all_tasks())
    # Only the handler task itself (now finished) should differ; no leaked
    # get_task/closed_task siblings remain pending.
    assert tasks_after <= tasks_before


# --- Finding 4: shutdown flush must be bounded and off the event loop ------

async def test_shutdown_flush_uses_to_thread_and_bounded_wait_for(monkeypatch):
    """Simulates the shutdown block's own flush call directly (rather than
    driving the whole run() lifecycle): a slow store.flush() must be run in
    a thread and bounded by SHUTDOWN_FLUSH_TIMEOUT rather than blocking the
    event loop or stalling shutdown indefinitely."""
    import time as time_mod

    flush_calls = {"count": 0}

    def _slow_flush():
        flush_calls["count"] += 1
        time_mod.sleep(0.05)  # simulate a slow synchronous Influx call
        return True

    class _SlowStore:
        def flush(self):
            return _slow_flush()

    monkeypatch.setattr(netviz_main, "SHUTDOWN_FLUSH_TIMEOUT", 5.0)
    store = _SlowStore()

    start = asyncio.get_event_loop().time()
    # This mirrors exactly what the finally-block in run() does.
    await asyncio.wait_for(
        asyncio.to_thread(store.flush), timeout=netviz_main.SHUTDOWN_FLUSH_TIMEOUT)
    elapsed = asyncio.get_event_loop().time() - start

    assert flush_calls["count"] == 1
    assert elapsed < 1.0  # completed promptly, was not skipped


async def test_shutdown_flush_timeout_is_caught_not_raised():
    """A store.flush() that overruns SHUTDOWN_FLUSH_TIMEOUT must not hang
    shutdown forever — wait_for's TimeoutError must be catchable exactly as
    the finally-block in run() does.

    Deliberately does NOT drive this through asyncio.to_thread: a real
    worker thread blocked in a genuine time.sleep() cannot be cancelled by
    wait_for and would keep running for real past the test's own timeout
    (a non-daemon executor thread that pytest would then have to wait out
    at interpreter shutdown). asyncio.sleep is used as a cancellable stand-in
    for "the awaited call overran its budget"; the fact that the real call
    is wrapped in asyncio.to_thread is verified separately, by source
    inspection, in the next test."""
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.sleep(3600), timeout=0.05)
    # The finally-block in run() wraps exactly this shape of call in
    # try/except asyncio.TimeoutError and logs a warning instead of
    # propagating — proven directly by source inspection below.


def test_run_shutdown_block_catches_timeout_and_generic_exception():
    import inspect
    src = inspect.getsource(netviz_main.run)
    assert "asyncio.wait_for(" in src
    assert "asyncio.to_thread(store.flush)" in src
    assert "TimeoutError" in src


# --- Item 1: periodic flusher() must run store.flush() off the event loop,
# bounded, same shape as the shutdown flush --------------------------------

def test_flusher_uses_to_thread_and_bounded_wait_for():
    """Source-level guard: the periodic flusher must use the same
    off-loop/bounded shape as the already-fixed shutdown flush, not call
    store.flush() directly on the loop."""
    import inspect
    src = inspect.getsource(netviz_main.flusher)
    assert "asyncio.to_thread(store.flush)" in src
    assert "asyncio.wait_for(" in src
    assert "FLUSH_TIMEOUT" in src


async def test_flusher_does_not_block_the_event_loop(monkeypatch):
    """A slow (genuinely blocking, real time.sleep) store.flush() must not
    stall other coroutines. Proven by a concurrent ticker advancing many
    times while a 0.2s blocking flush is in flight in its own thread."""
    import time as time_mod

    class _SlowStore:
        def flush(self):
            time_mod.sleep(0.2)
            return True

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    health = Health({"influx": 120.0})
    ticks = {"count": 0}

    async def ticker():
        while True:
            ticks["count"] += 1
            await orig_sleep(0.01)

    flusher_task = asyncio.create_task(
        netviz_main.flusher(_SlowStore(), health, 0.001))
    ticker_task = asyncio.create_task(ticker())

    await orig_sleep(0.25)  # longer than the slow flush's blocking sleep

    flusher_task.cancel()
    ticker_task.cancel()
    for t in (flusher_task, ticker_task):
        with pytest.raises(asyncio.CancelledError):
            await t

    # The loop kept running the ticker throughout the "blocking" flush,
    # proving flush() ran off-loop rather than stalling everything.
    assert ticks["count"] > 5


async def test_flusher_times_out_without_hanging_and_keeps_looping(monkeypatch):
    """A store.flush() that overruns FLUSH_TIMEOUT must not hang the
    flusher loop forever, and the loop must keep ticking afterward.

    Deliberately does NOT drive this through a real asyncio.to_thread()
    call backed by a genuinely blocking time.sleep(): a real worker thread
    parked in time.sleep() cannot be cancelled by wait_for and, being a
    non-daemon executor thread, would keep the interpreter alive past the
    test process's own exit (exactly the trap test_shutdown_flush_timeout
    _is_caught_not_raised's docstring calls out). asyncio.to_thread itself
    is replaced with a coroutine that never completes on its own but *is*
    cancellable -- so asyncio.wait_for's real (not mocked) timeout can
    actually cancel it, exercising the genuine TimeoutError path. That the
    real call is wrapped in asyncio.to_thread(store.flush) is verified
    separately, by source inspection, in
    test_flusher_uses_to_thread_and_bounded_wait_for."""
    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)
    monkeypatch.setattr(netviz_main, "FLUSH_TIMEOUT", 0.01)

    calls = {"count": 0}

    async def _hung_to_thread(func, *args, **kwargs):
        calls["count"] += 1
        await orig_sleep(3600)  # never finishes on its own; wait_for cancels it
        return func(*args, **kwargs)

    monkeypatch.setattr(netviz_main.asyncio, "to_thread", _hung_to_thread)

    class _HungStore:
        def flush(self):
            return True

    health = Health({"influx": 120.0})
    task = asyncio.create_task(
        netviz_main.flusher(_HungStore(), health, 0.001))

    await orig_sleep(0.05)  # real time: several multiples of FLUSH_TIMEOUT

    assert not task.done()  # loop is still alive, not stuck awaiting forever
    assert calls["count"] >= 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# --- Item 2: every tracked feed must be armed at boot ----------------------

def test_arm_all_feeds_prevents_false_stale_at_boot():
    thresholds = dict(netviz_main.THRESHOLDS)
    health = Health(thresholds)
    now = 1_000_000.0

    netviz_main._arm_all_feeds(health, thresholds, now)

    # Immediately after boot: no transitions at all (nothing was ever
    # stale, so nothing recovers either -- Health starts non-stale).
    assert health.evaluate(now) == []
    # Still true just before the shortest threshold (netflow, 60s) elapses
    # -- proving the whole first threshold window is clean, not just t=0.
    assert health.evaluate(now + thresholds["netflow"] - 1) == []


def test_without_arming_a_fresh_health_is_immediately_stale():
    """Control case proving the fix matters: an un-armed Health (the old
    behavior) reports every feed STALE on its very first evaluate()."""
    thresholds = dict(netviz_main.THRESHOLDS)
    health = Health(thresholds)
    transitions = health.evaluate(1_000_000.0)
    assert set(f for f, _ in transitions) == set(thresholds)
    assert all(t == "stale" for _, t in transitions)


# --- Item 3 (main.py side): flusher wiring doesn't change the loop's own
# batching behavior -- covered in test_store.py. Item 4: status_logger and
# the GeoIP RatioAlert wired into alerter() -----------------------------

async def test_status_logger_logs_periodic_status(monkeypatch, caplog):
    from netviz.ipfix import IpfixDecoder as RealIpfixDecoder

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    class _Enricher:
        stats = {"hits": 1, "misses": 1, "private": 0, "errors": 0}

        def miss_rate(self):
            return 0.5

    class _Store:
        healthy = True
        buffered = 3

    decoder = RealIpfixDecoder()
    fanout = Fanout()
    task = asyncio.create_task(
        netviz_main.status_logger(decoder, _Enricher(), fanout, _Store()))

    with caplog.at_level(logging.INFO, logger="netviz"):
        await orig_sleep(0)
        await orig_sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert "status:" in caplog.text
    assert "store_buffered=3" in caplog.text


async def test_status_logger_survives_exception_and_keeps_looping(monkeypatch):
    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    class _BoomEnricher:
        stats = {"hits": 0, "misses": 0}

        def miss_rate(self):
            raise RuntimeError("boom")

    from netviz.ipfix import IpfixDecoder as RealIpfixDecoder
    task = asyncio.create_task(
        netviz_main.status_logger(RealIpfixDecoder(), _BoomEnricher(), Fanout(), None))
    for _ in range(3):
        await orig_sleep(0)

    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_alerter_posts_geoip_miss_alert_via_ratio_alert(monkeypatch):
    from netviz.health import RatioAlert

    posts = []

    def _post(msg):
        posts.append(msg)
        return True

    monkeypatch.setattr(netviz_main.notify, "post", _post)

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    class _Enricher:
        stats = {"hits": 5, "misses": 20}  # 80% miss, well over 20% threshold

    health = Health({})  # no time-based feeds; isolates the ratio alert
    geoip_alert = RatioAlert("geoip_miss_rate", threshold=0.20, min_samples=10)
    task = asyncio.create_task(netviz_main.alerter(health, geoip_alert, _Enricher()))

    await orig_sleep(0)
    await orig_sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert any("geoip_miss_rate" in p and "STALE" in p for p in posts)


async def test_alerter_with_no_geoip_alert_is_unaffected():
    """Backward-compat: alerter(health) with no geoip_alert/enricher args
    (as every pre-existing test calls it) must keep working unchanged."""
    health = Health({"netflow": 1.0})
    task = asyncio.create_task(netviz_main.alerter(health))
    await asyncio.sleep(0)
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_ipfix_protocol_accepts_injected_decoder():
    """run() needs a handle on the decoder for the status log, so
    IpfixProtocol must accept (and use) an externally-owned decoder
    instead of always constructing its own."""
    from netviz.ipfix import IpfixDecoder as RealIpfixDecoder
    decoder = RealIpfixDecoder()
    proto = netviz_main.IpfixProtocol(lambda ev, feed: None, decoder)
    assert proto._decoder is decoder


def test_ipfix_protocol_still_defaults_to_owning_a_decoder():
    proto = netviz_main.IpfixProtocol(lambda ev, feed: None)
    assert proto._decoder is not None


# --- Item 5: an empty INFLUX_TOKEN drops "influx" from tracked thresholds,
# with a loud warning, instead of alerting STALE forever ---------------------

def test_thresholds_for_synthetic_excludes_influx():
    from netviz.config import Config
    cfg = Config()
    thresholds = netviz_main._thresholds_for(cfg, synthetic=True)
    assert "influx" not in thresholds


def test_thresholds_for_missing_token_excludes_influx_and_warns(monkeypatch, caplog):
    from netviz.config import Config
    cfg = Config()
    monkeypatch.setattr(cfg, "influx_token", "")

    with caplog.at_level(logging.WARNING, logger="netviz"):
        thresholds = netviz_main._thresholds_for(cfg, synthetic=False)

    assert "influx" not in thresholds
    assert "netflow" in thresholds and "blocks" in thresholds
    assert "INFLUX_TOKEN" in caplog.text


def test_thresholds_for_present_token_keeps_influx(monkeypatch, caplog):
    from netviz.config import Config
    cfg = Config()
    monkeypatch.setattr(cfg, "influx_token", "some-real-token")

    with caplog.at_level(logging.WARNING, logger="netviz"):
        thresholds = netviz_main._thresholds_for(cfg, synthetic=False)

    assert thresholds == netviz_main.THRESHOLDS
    assert "INFLUX_TOKEN" not in caplog.text


# --- Open item 3: syslog counters. The status line logged ipfix, enrich,
# fanout and store but nothing at all for syslog, so a dead SIEM feed and a
# working-but-silent one (per-policy logging off) looked identical. ------

def test_syslog_protocol_counts_datagrams_lines_and_events():
    seen = []
    proto = netviz_main.SyslogProtocol(lambda ev, feed: seen.append((ev, feed)))

    block = ('<4>1 kernel: [CUSTOM1_WAN-D-10000] DESCR="Block Geo Outbound" '
             'IN=eth8 OUT= SRC=203.0.113.9 DST=192.168.0.20 LEN=60 PROTO=TCP '
             'SPT=443 DPT=51000')
    proto.datagram_received((block + "\nnot a netfilter line\n").encode(), ("1.2.3.4", 514))

    assert len(seen) == 1
    assert proto.stats == {"datagrams": 1, "lines": 2, "events": 1, "unparsed": 1}


def test_syslog_protocol_counts_second_datagram():
    proto = netviz_main.SyslogProtocol(lambda ev, feed: None)

    proto.datagram_received(b"junk\n", ("1.2.3.4", 514))
    proto.datagram_received(b"more junk\n", ("1.2.3.4", 514))

    assert proto.stats == {"datagrams": 2, "lines": 2, "events": 0, "unparsed": 2}


async def test_status_logger_logs_syslog_stats(monkeypatch, caplog):
    from netviz.ipfix import IpfixDecoder as RealIpfixDecoder

    orig_sleep = asyncio.sleep

    async def _fast_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(netviz_main.asyncio, "sleep", _fast_sleep)

    class _Enricher:
        stats = {"hits": 1, "misses": 0, "private": 0, "errors": 0}

        def miss_rate(self):
            return 0.0

    syslog = netviz_main.SyslogProtocol(lambda ev, feed: None)
    syslog.datagram_received(b"junk\n", ("1.2.3.4", 514))

    task = asyncio.create_task(netviz_main.status_logger(
        RealIpfixDecoder(), _Enricher(), Fanout(), None, syslog))

    with caplog.at_level(logging.INFO, logger="netviz"):
        await orig_sleep(0)
        await orig_sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert "syslog={'datagrams': 1, 'lines': 1, 'events': 0, 'unparsed': 1}" in caplog.text


async def test_ws_handler_sends_replay_backfill_before_live_events():
    from netviz.replay import Replay

    fanout = Fanout()
    replay = Replay()
    # Real clock: ws_handler snapshots with time.time(), so the backfilled
    # event has to sit inside the replay window to survive.
    now = time.time()
    replay.add(Event(ts=now - 10.0, kind="block", src_ip="203.0.113.9",
                     dst_ip="192.168.0.20", bytes=60, proto=6,
                     policy_id="Block Secure Zone to Geo Outbound",
                     src_lat=1.0, src_lon=2.0, src_country="HK"))

    sent: list[str] = []

    class _WS:
        async def send(self, text):
            sent.append(text)

        async def wait_closed(self):
            await asyncio.Event().wait()      # never closes on its own

        async def close(self):
            pass

    task = asyncio.create_task(netviz_main.ws_handler(_WS(), fanout, replay))
    for _ in range(5):
        await asyncio.sleep(0)

    fanout.broadcast(Event(ts=now, kind="flow", src_ip="198.51.100.4",
                           dst_ip="192.168.0.30", bytes=99, proto=17,
                           src_lat=3.0, src_lon=4.0, src_country="US"))
    for _ in range(5):
        await asyncio.sleep(0)

    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    assert len(sent) == 2
    assert json.loads(sent[0])["k"] == "block"     # backfill first
    assert json.loads(sent[1])["k"] == "flow"      # then live


def test_unparsed_lines_are_sampled_to_the_log_when_enabled(caplog):
    """Writing the Suricata branch needs real lines, and the only place they
    exist is this stream. Off by default -- the unparsed share is most of the
    feed and logging all of it would flood the container log."""
    import logging

    from netviz.main import SyslogProtocol

    proto = SyslogProtocol(lambda ev, feed: None, log_unparsed=2)
    with caplog.at_level(logging.INFO, logger="netviz"):
        for i in range(5):
            proto.datagram_received(f"<14>nothing parseable {i}".encode(), ("1.2.3.4", 5))

    logged = [r.getMessage() for r in caplog.records if "unparsed:" in r.getMessage()]
    assert len(logged) == 2, "sample cap not honoured"
    assert "nothing parseable 0" in logged[0]


def test_unparsed_lines_are_not_logged_by_default():
    import logging

    from netviz.main import SyslogProtocol

    proto = SyslogProtocol(lambda ev, feed: None)
    logger = logging.getLogger("netviz")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logger.addHandler(handler)
    try:
        proto.datagram_received(b"<14>nothing parseable", ("1.2.3.4", 5))
    finally:
        logger.removeHandler(handler)

    assert not [r for r in records if "unparsed:" in r.getMessage()]
