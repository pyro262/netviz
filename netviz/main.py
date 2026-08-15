"""Wiring. Two UDP listeners and a WebSocket server share one event loop; the
store runs on its own timer so a slow Influx cannot stall ingest."""
import argparse
import asyncio
import contextlib
import json
import logging
import random
import signal
import time
from pathlib import Path
from typing import Optional

import websockets

from . import __version__
from .aurora import KpCache, fetch_kp, next_poll_delay
from . import clouds as clouds_mod
from . import lightning as lightning_mod
from .config import Config
from .enrich import Enricher, load_centroids
from .events import Event
from .fanout import CLOSE, Fanout
from .health import Health, RatioAlert
from .ipfix import IpfixDecoder
from .release import ReleaseCache
from .replay import Replay
from .static_files import make_process_request
from .stats import Stats
from .store import Store
from .syslog_parse import parse_syslog_line
from .synthetic import DEMO_HIGHLIGHT_PREFIXES, SyntheticFeed
from .xtgeoip import XtGeoIP
from . import notify

log = logging.getLogger("netviz")

THRESHOLDS = {"netflow": 60.0, "blocks": 21600.0, "influx": 120.0}

# Synthetic mode never runs the flusher (there is no store), so nothing ever
# re-arms the "influx" feed after the one startup health.saw() call. Tracking
# it there would false-alarm STALE after cfg's influx threshold on every long
# synthetic run — exactly the mode expected to run for hours while the
# renderer is built. Synthetic mode tracks only the feeds it actually drives.
SYNTHETIC_THRESHOLDS = {k: v for k, v in THRESHOLDS.items() if k != "influx"}

# Final flush on shutdown must not stall process exit indefinitely if Influx
# is unreachable — bounded below by this timeout.
SHUTDOWN_FLUSH_TIMEOUT = 10.0

# The periodic (non-shutdown) flush is off the event loop too -- store.flush()
# does a blocking HTTP POST via InfluxWriter.write(), and a hung (not merely
# refusing) Influx would otherwise stall the entire loop: no UDP read, no
# ws.send(), and health.saw() never called on a feed that is actually fine.
# Bounded independently of the shutdown timeout since it recurs forever
# rather than running once.
FLUSH_TIMEOUT = 15.0

# How often the operational status line is logged: decoder/enricher/fanout
# counters and store health, none of which anything reads today otherwise.
STATUS_LOG_SECONDS = 60.0

# Spec 6.2: alert if GeoIP miss rate exceeds 20% over a meaningful sample.
GEOIP_MISS_THRESHOLD = 0.20
GEOIP_MISS_MIN_SAMPLES = 50


class InfluxWriter:
    def __init__(self, cfg: Config) -> None:
        from influxdb_client import InfluxDBClient
        from influxdb_client.client.write_api import SYNCHRONOUS
        self._client = InfluxDBClient(url=cfg.influx_url, token=cfg.influx_token,
                                      org=cfg.influx_org)
        self._api = self._client.write_api(write_options=SYNCHRONOUS)
        self._bucket = cfg.influx_bucket

    def write(self, points: list[dict]) -> None:
        self._api.write(bucket=self._bucket, record=points, write_precision="ns")


class IpfixProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_event, decoder: "IpfixDecoder | None" = None) -> None:
        # Accepts an existing decoder so run() can hold a reference to it
        # for the periodic status log (decoder.stats) -- the decoder is
        # otherwise created and owned entirely inside this protocol, with
        # nothing outside able to see message/template/record counters.
        self._decoder = decoder if decoder is not None else IpfixDecoder()
        self._on_event = on_event

    def datagram_received(self, data: bytes, addr) -> None:
        for ev in self._decoder.decode(data):
            self._on_event(ev, "netflow")


class SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_event, log_unparsed: int = 0) -> None:
        self._on_event = on_event
        # Sample of lines the parser rejected, for building new parser branches
        # against the real stream instead of guessing at its format. A budget,
        # not a flag: most of this feed is admin/device/Suricata noise with no
        # SRC=, so logging all of it would bury the container log.
        self._log_unparsed = log_unparsed
        # Counted so the status log can tell a dead SIEM feed (datagrams 0)
        # apart from a live one carrying no policy logs (datagrams climbing,
        # events 0) -- indistinguishable without this.
        self.stats = {"datagrams": 0, "lines": 0, "events": 0, "unparsed": 0}

    def datagram_received(self, data: bytes, addr) -> None:
        self.stats["datagrams"] += 1
        for line in data.decode("utf-8", "replace").splitlines():
            self.stats["lines"] += 1
            ev = parse_syslog_line(line)
            if ev is None:
                self.stats["unparsed"] += 1
                if self._log_unparsed > 0:
                    self._log_unparsed -= 1
                    log.info("syslog unparsed: %s", line)
            else:
                self.stats["events"] += 1
                self._on_event(ev, "blocks")


async def ws_handler(ws, fanout: Fanout, replay: "Optional[Replay]" = None) -> None:
    """Serve one kiosk connection. Drains fanout's per-client queue and
    forwards each event over the WebSocket, until either the client
    disconnects or the fanout tells us to close it via the CLOSE sentinel
    (queue overflow — the kiosk fell behind). CLOSE must never be handed to
    json.dumps and must never be treated as an ordinary event.

    Waits on queue.get() and the connection's own close-waiter together, so
    a kiosk that vanishes mid-quiet-period (no broadcast to trigger a failed
    ws.send()) is still noticed and unregistered immediately, rather than
    leaking its registration and queue until the next broadcast.

    Registers the queue BEFORE snapshotting the replay buffer so no event can
    slip through the gap. The cost is that an event may appear in both, drawing
    one arc twice for a few frames on connect; the wire format carries no event
    identity to dedupe on, and an ephemeral doubled arc is not worth inventing
    one for."""
    key = id(ws)
    queue = fanout.register(key)
    log.info("kiosk connected (%d total)", fanout.client_count)
    try:
        if replay is not None:
            backfill = replay.snapshot(time.time())
            log.info("kiosk %s backfill: %d events", key, len(backfill))
            for payload in backfill:
                await ws.send(payload)      # already JSON text, do not re-encode
        while True:
            get_task = asyncio.ensure_future(queue.get())
            closed_task = asyncio.ensure_future(ws.wait_closed())
            try:
                done, pending = await asyncio.wait(
                    [get_task, closed_task], return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in (get_task, closed_task):
                    if not t.done():
                        t.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await t

            if closed_task in done:
                log.info("kiosk %s connection closed", key)
                break

            wire = get_task.result()
            if wire is CLOSE:
                log.info("kiosk %s dropped (slow consumer)", key)
                break
            await ws.send(json.dumps(wire))
    except websockets.ConnectionClosed:
        pass
    finally:
        fanout.unregister(key)
        with contextlib.suppress(Exception):
            await ws.close()


async def flusher(store: Store, health: Health, flush_seconds: float) -> None:
    while True:
        await asyncio.sleep(flush_seconds)
        try:
            if store is not None:
                # store.flush() ends in a synchronous Influx HTTP POST
                # (InfluxWriter uses write_options=SYNCHRONOUS) plus a
                # buffer fsync of up to 10,000 lines. Called directly, a
                # hung (not merely refusing) influxdb stalls this whole
                # event loop for the client's connect/read timeout: no UDP
                # datagram gets read (kernel buffer overflows, netflow is
                # silently lost), no ws.send() runs (kiosk queues fill to
                # 256 and clients get dropped as "slow consumers" when they
                # are not), and health.saw("netflow") never fires (the
                # service alerts STALE on a feed that is perfectly
                # healthy). Run it in a thread, bounded, same shape as the
                # shutdown flush below.
                try:
                    ok = await asyncio.wait_for(
                        asyncio.to_thread(store.flush), timeout=FLUSH_TIMEOUT)
                except asyncio.TimeoutError:
                    log.warning(
                        "flusher: store.flush() timed out after %.0fs, "
                        "continuing (buffer keeps accumulating on disk)",
                        FLUSH_TIMEOUT)
                    ok = False
                if ok:
                    health.saw("influx", time.time())
        except Exception:
            log.exception("flusher: unhandled error, continuing")


def _arm_all_feeds(health: Health, thresholds: dict, now: float) -> None:
    """Call once at boot, before the alerter task starts. Health._is_stale
    treats a never-seen feed as stale immediately, and the alerter's first
    evaluate() runs 30s in -- so a cold start with no traffic yet in those
    30s posts a false STALE for every tracked feed, including the
    deliberately long ones (blocks: 6h). Watchtower restarts containers
    routinely, so left unfixed this fires on a schedule, not an exception."""
    for feed in thresholds:
        health.saw(feed, now)


async def aurora_poller(cache: "KpCache") -> None:
    """Refresh the planetary Kp index, once per publication.

    NOAA publishes on 3-hour boundaries, so that is the cadence: asking every
    five minutes was the same question 36 times over. The delay is aligned to
    fire just after each boundary rather than every 3 hours from whenever the
    collector happened to start, which would otherwise sit up to a full period
    behind the data.

    One fetch straight away so the wall is not blank until the next boundary.
    The fetch is blocking urllib, so it runs in a thread -- a hung NOAA must not
    stall the event loop, same reasoning as the Influx flusher.
    """
    while True:
        try:
            kp = await asyncio.wait_for(asyncio.to_thread(fetch_kp), timeout=30.0)
            cache.update(kp, time.time())
        except (asyncio.TimeoutError, Exception) as err:   # noqa: BLE001
            log.warning("aurora: poll failed: %s", err)
        await asyncio.sleep(next_poll_delay(time.time()))


async def cloud_poller(cache: "clouds_mod.CloudCache", cfg: Config) -> None:
    """Refresh the global cloud mosaic, once per publication.

    GMGSI is hourly and each granule appears roughly half an hour after the
    hour it covers, so the delay is aligned just after that rather than every
    3600s from whenever the collector started -- the same argument as the
    aurora poller, with a longer tail because the publication itself is late.

    Blocking urllib and a 7 MB download, so it runs in a thread: a slow S3 must
    not stall the event loop any more than a slow NOAA may.

    Disabled outright when `NETVIZ_CLOUDS=0`, and silent when the optional
    parsing dependencies are absent -- a collector with no h5py serves no
    /clouds.png and the renderer draws no shell, which is the same path as a
    fetch that has never succeeded.
    """
    if not cfg.clouds_enabled:
        log.info("clouds: disabled")
        return
    while True:
        try:
            await asyncio.wait_for(
                asyncio.to_thread(clouds_mod.refresh, cache, cfg.state_dir),
                timeout=300.0)
        except (asyncio.TimeoutError, Exception) as err:   # noqa: BLE001
            log.warning("clouds: poll failed: %s", err)
        await asyncio.sleep(clouds_mod.next_poll_delay(time.time()))


async def lightning_poller(cache: "lightning_mod.LightningCache", cfg: Config) -> None:
    """Refresh the played bucket, once per publication.

    Blitzortung publishes a 10-minute bucket about 31 minutes after the minute
    it starts, so the delay is aligned just after that -- the same argument as
    the aurora and cloud pollers. The unhealthy retry is 120s rather than the
    cloud layer's 300: a bucket only stays useful for the 600 seconds it takes
    to play, so noticing a recovered upstream after five minutes would mean
    noticing it with most of the bucket already spent.

    Blocking urllib and gzip, so it runs in a thread.
    """
    if not cfg.lightning_enabled:
        log.info("lightning: disabled")
        return
    while True:
        healthy = False
        try:
            healthy = await asyncio.wait_for(
                asyncio.to_thread(lightning_mod.refresh, cache), timeout=120.0)
        except (asyncio.TimeoutError, Exception) as err:   # noqa: BLE001
            log.warning("lightning: poll failed: %s", err)
        delay = (lightning_mod.next_poll_delay(time.time()) if healthy else 120.0)
        await asyncio.sleep(delay)


async def alerter(health: Health, geoip_alert: Optional[RatioAlert] = None,
                   enricher: Optional[Enricher] = None) -> None:
    while True:
        await asyncio.sleep(30)
        try:
            transitions = list(health.evaluate(time.time()))
            # Reuse the same once-on-entry/once-on-recovery discipline (and
            # the same posting path) for the GeoIP miss-rate condition,
            # rather than a second alerting mechanism per spec 6.2/6.3.
            if geoip_alert is not None and enricher is not None:
                transitions += geoip_alert.evaluate(
                    enricher.stats["misses"], enricher.stats["hits"])
            for feed, transition in transitions:
                msg = (f"netviz: feed `{feed}` is STALE" if transition == "stale"
                       else f"netviz: feed `{feed}` recovered")
                log.warning(msg)
                try:
                    await asyncio.to_thread(notify.post, msg)
                except Exception:
                    log.exception("alerter: notify.post failed, continuing")
        except Exception:
            log.exception("alerter: unhandled error, continuing")


async def status_logger(decoder: IpfixDecoder, enricher: Enricher, fanout: Fanout,
                         store: Optional[Store],
                         syslog: "Optional[SyslogProtocol]" = None) -> None:
    """Periodic operational visibility. Nothing else ever reads
    decoder.stats, enricher.stats/miss_rate(), fanout.stats or
    store.healthy/buffered -- so a stale/broken .mmdb dropping 100% of
    events, or a ./state directory the container can't write to, would
    otherwise surface only as a generic netflow STALE alert (or nothing at
    all)."""
    while True:
        await asyncio.sleep(STATUS_LOG_SECONDS)
        try:
            log.info(
                "status: ipfix=%s syslog=%s enrich=%s miss_rate=%.1f%% "
                "fanout_clients=%d fanout=%s store_healthy=%s store_buffered=%s",
                decoder.stats, syslog.stats if syslog is not None else None,
                enricher.stats, enricher.miss_rate() * 100,
                fanout.client_count, fanout.stats,
                store.healthy if store is not None else None,
                store.buffered if store is not None else None,
            )
        except Exception:
            log.exception("status_logger: unhandled error, continuing")


async def synth(on_event, rng: random.Random, highlight_prefixes=None) -> None:
    feed = SyntheticFeed(highlight_prefixes=highlight_prefixes)
    while True:
        await asyncio.sleep(0.2)
        try:
            on_event(feed.next_flow(), "netflow")
            if rng.random() < 0.08:
                on_event(feed.next_block(), "blocks")
        except Exception:
            log.exception("synth: unhandled error, continuing")


def _thresholds_for(cfg: Config, synthetic: bool) -> dict:
    """The set of feeds Health should track for this run.

    Synthetic mode never runs the flusher (no store), so "influx" is
    dropped -- tracking it there would false-alarm STALE after
    THRESHOLDS["influx"] on every long synthetic run.

    Same reasoning applies, separately, when INFLUX_TOKEN is unset: `store`
    stays None (see run()), the flusher no-ops forever, and nothing ever
    calls health.saw("influx", ...) -- so "influx" would sit at its 120s
    threshold permanently STALE, a standing false alert rather than a real
    outage signal. Warn loudly once at startup so a missing token isn't a
    silent footgun, and drop the feed the same way synthetic mode does."""
    if synthetic:
        return dict(SYNTHETIC_THRESHOLDS)
    if not cfg.influx_token:
        log.warning(
            "INFLUX_TOKEN not set: storage disabled, history will not be "
            "written to InfluxDB. Buffering and the 'influx' health feed "
            "are both off.")
        return {k: v for k, v in THRESHOLDS.items() if k != "influx"}
    return dict(THRESHOLDS)


async def run(cfg: Config, synthetic: bool) -> None:
    fanout = Fanout()
    replay = Replay()
    static_root = Path(__file__).resolve().parent / "static"
    enricher = None if synthetic else Enricher(cfg.mmdb_path,
                                               (cfg.home_lat, cfg.home_lon))
    if enricher is not None:
        # The router's own geo tables, if this install fetched them. Both
        # halves must be present to be useful: the tables say which country,
        # the bake says where to draw it.
        enricher.xt = XtGeoIP.load(cfg.xt_geoip_dir)
        if enricher.xt is not None:
            enricher.centroids = load_centroids(
                str(static_root / "data" / "borders-index.json"))
            if not enricher.centroids:
                log.warning("xt_geoip: tables loaded but no centroids -- "
                            "block events keep their MaxMind coordinates")
    # Opt-in, and started before the server so the first poll overlaps startup
    # rather than delaying it. Never in synthetic mode: that is a development
    # run against no router, and it should make no outbound requests at all.
    release = None
    if cfg.update_repo and not synthetic:
        release = ReleaseCache(cfg.update_repo, __version__)
        release.start()
        log.info("release check: watching %s (running %s)",
                 cfg.update_repo, __version__)

    thresholds = _thresholds_for(cfg, synthetic)
    store = None
    if not synthetic and cfg.influx_token:
        store = Store(InfluxWriter(cfg), cfg.buffer_path)

    # Feeds /stats.json, which only the optional right rail reads. Always
    # populated: the counters cost two dict lookups per event, and a kiosk
    # whose menu just turned the rail on must not have to wait 24h for the
    # window to fill from the moment somebody asked for it.
    stats = Stats()

    # Synthetic mode with nothing configured still needs highlighted networks,
    # or the renderer classes it exists to exercise never appear. Fill the
    # empty slots with the demo prefixes and serve those to the page, so the
    # feed and the display agree on what is highlighted.
    highlight_networks = cfg.highlight_networks
    if synthetic and not any(n["prefix"] for n in highlight_networks):
        for slot, prefix in zip(highlight_networks, DEMO_HIGHLIGHT_PREFIXES):
            slot["prefix"] = prefix
        log.info("synthetic: highlighting demo networks %s",
                 ", ".join(DEMO_HIGHLIGHT_PREFIXES))

    health = Health(thresholds)
    # Arm every tracked feed at boot so the alerter's first tick (30s in)
    # does not treat a cold start's first few seconds of silence as STALE.
    _arm_all_feeds(health, thresholds, time.time())
    geoip_alert = (None if synthetic else
                   RatioAlert("geoip_miss_rate", GEOIP_MISS_THRESHOLD,
                              GEOIP_MISS_MIN_SAMPLES))

    def on_event(ev: Event, feed: str) -> None:
        # Called directly from datagram_received for every event decoded out
        # of one UDP datagram. enricher/health/fanout/store are not
        # internally hardened the way the decoder and parser are, so a
        # failure here must not propagate back into the protocol's
        # datagram_received loop — that would abandon every remaining event
        # in the same datagram and, in CPython, only survives today because
        # asyncio's per-callback exception handling happens to contain it
        # (incidental, not designed-in), while the failure itself stays
        # invisible with no logging at all.
        try:
            if enricher is not None:
                enriched = enricher.enrich(ev)
                if enriched is None:
                    return
                ev = enriched
            health.saw(feed, time.time())
            fanout.broadcast(ev)          # live path first, always
            replay.add(ev)                # then history for the next kiosk
            if store is not None:
                store.add(ev)
            # Last: the rail is the least important consumer, so if this ever
            # throws it must not have already cost the display its arc.
            stats.note(ev)
        except Exception:
            log.exception("on_event: unhandled error for feed %s, continuing", feed)

    loop = asyncio.get_running_loop()
    kp_cache = KpCache()
    cloud_cache = clouds_mod.CloudCache(cfg.cloud_path)
    lightning_cache = lightning_mod.LightningCache()
    tasks = [asyncio.create_task(alerter(health, geoip_alert, enricher)),
             asyncio.create_task(aurora_poller(kp_cache)),
             asyncio.create_task(cloud_poller(cloud_cache, cfg)),
             asyncio.create_task(lightning_poller(lightning_cache, cfg))]

    if synthetic:
        # No store, no flusher in synthetic mode, so "influx" is not a feed
        # this run drives at all — Health was built with SYNTHETIC_THRESHOLDS
        # above, which excludes it, so there is nothing to arm here.
        tasks.append(asyncio.create_task(synth(
            on_event, random.Random(),
            [n["prefix"] for n in highlight_networks])))
    else:
        decoder = IpfixDecoder(template_path=cfg.template_path)
        stats.decoder = decoder
        stats.enricher = enricher
        await loop.create_datagram_endpoint(
            lambda: IpfixProtocol(on_event, decoder), local_addr=("0.0.0.0", cfg.ipfix_port))
        syslog = SyslogProtocol(on_event, log_unparsed=cfg.log_unparsed)
        stats.syslog = syslog
        await loop.create_datagram_endpoint(
            lambda: syslog, local_addr=("0.0.0.0", cfg.syslog_port))
        tasks.append(asyncio.create_task(flusher(store, health, cfg.flush_seconds)))
        tasks.append(asyncio.create_task(
            status_logger(decoder, enricher, fanout, store, syslog)))

    stop_event = asyncio.Event()

    def _request_stop() -> None:
        stop_event.set()

    with contextlib.suppress(NotImplementedError):
        # Not available on Windows; container/host here is Linux.
        loop.add_signal_handler(signal.SIGTERM, _request_stop)
        loop.add_signal_handler(signal.SIGINT, _request_stop)

    try:
        async with websockets.serve(lambda ws: ws_handler(ws, fanout, replay),
                                    "0.0.0.0", cfg.ws_port,
                                    process_request=make_process_request(
                                        static_root, health=health,
                                        kp_cache=kp_cache, stats=stats,
                                        release=release, clouds=cloud_cache,
                                        lightning=lightning_cache,
                                        # Built by Config so there is one
                                        # whitelist, not two. Hand-rolling the
                                        # dict here is how the home position
                                        # reached /config.json in tests and not
                                        # on the wire. The networks are passed
                                        # separately because synthetic mode
                                        # substitutes demo prefixes into them.
                                        display_config={
                                            **cfg.display_config(),
                                            "highlight": {
                                                "networks": highlight_networks}})):
            log.info("netviz listening: ws=%d http=%s synthetic=%s",
                     cfg.ws_port, static_root, synthetic)
            stopper = asyncio.create_task(stop_event.wait())
            done, pending = await asyncio.wait(
                [*tasks, stopper], return_when=asyncio.FIRST_COMPLETED)
            if stopper not in done:
                stopper.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stopper
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        if store is not None:
            log.info("shutting down: final store flush")
            # store.flush() calls the (synchronous) Influx client, which can
            # block on its own HTTP timeout if Influx is unreachable. Run it
            # off the event loop and bound it so shutdown can never stall
            # indefinitely waiting on a dead server.
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(store.flush), timeout=SHUTDOWN_FLUSH_TIMEOUT)
            except asyncio.TimeoutError:
                log.warning(
                    "shutting down: final store flush timed out after %.0fs, "
                    "buffered events remain on disk", SHUTDOWN_FLUSH_TIMEOUT)
            except Exception:
                log.exception("shutting down: final store flush failed")
        if enricher is not None:
            enricher.close()


def cli() -> None:
    ap = argparse.ArgumentParser(prog="netviz")
    ap.add_argument("--synthetic", action="store_true",
                    help="generate fake events; no router, Influx or GeoIP needed")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(run(Config(), synthetic=args.synthetic))
    except KeyboardInterrupt:
        log.info("interrupted, shutting down")


if __name__ == "__main__":
    cli()
