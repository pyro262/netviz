"""Batched InfluxDB writes with a bounded on-disk buffer.

A failure here must never reach the live path: callers add() and move on. The
buffer survives a restart so a long Influx outage does not lose the window."""
import json
import os
import threading
import time
from collections import deque
from typing import Any, Protocol

from .events import Event


class Writer(Protocol):
    def write(self, points: list[dict]) -> None: ...


_REQUIRED_POINT_KEYS = {"measurement", "tags", "fields", "time"}


def _is_valid_point(obj: Any) -> bool:
    """Guard against head-of-line poisoning: a line that is valid JSON but
    not a point dict (a list, a number, a string) must never make it into
    the buffer. If it did, a real writer that chokes on it would fail the
    same leading batch on every retry forever, wedging everything behind
    it."""
    return isinstance(obj, dict) and _REQUIRED_POINT_KEYS.issubset(obj.keys())


def event_to_point(ev: Event) -> dict[str, Any]:
    return {
        "measurement": "netviz",
        "tags": {
            "kind": ev.kind,
            "src_country": ev.src_country or "??",
            "dst_country": ev.dst_country or "??",
            "policy_id": ev.policy_id or "",
        },
        "fields": {
            "bytes": int(ev.bytes),
            "proto": int(ev.proto),
            "src_ip": ev.src_ip,
            "dst_ip": ev.dst_ip,
            "src_lat": float(ev.src_lat) if ev.src_lat is not None else 0.0,
            "src_lon": float(ev.src_lon) if ev.src_lon is not None else 0.0,
            "dst_lat": float(ev.dst_lat) if ev.dst_lat is not None else 0.0,
            "dst_lon": float(ev.dst_lon) if ev.dst_lon is not None else 0.0,
        },
        "time": int(ev.ts * 1_000_000_000),
    }


class Store:
    def __init__(self, writer: Writer, buffer_path: str,
                 max_buffer: int = 10_000, batch: int = 200) -> None:
        self._writer = writer
        self._path = buffer_path
        self._batch = batch
        self._buf: deque[dict] = deque(maxlen=max_buffer)   # maxlen drops oldest
        self.healthy = True
        # Tracks whether in-memory state has diverged from what is on disk.
        # Lets flush() skip the write+fsync+rename cycle on a timer tick
        # where nothing changed (e.g. buffer stayed empty), which is the
        # common case and would otherwise pay fsync cost for nothing.
        self._dirty = False
        # Guards every mutation and read of self._buf/self._dirty. add()
        # (event loop thread) and flush()/_persist() (worker thread, via
        # asyncio.to_thread) touch the same deque concurrently -- a plain
        # `for` over a deque raises RuntimeError the moment its mutation
        # counter changes mid-iteration, and a snapshot-then-pop-by-count
        # done outside a single critical section can pop the wrong items
        # if add()'s maxlen eviction lands in between. Held only around
        # the actual buffer operations, never around file or network I/O,
        # so a slow fsync/HTTP write can never stall add() on the event
        # loop -- that would recreate the original blocking-store bug.
        self._lock = threading.Lock()
        # Re-entrancy guard: flush_seconds (10s) is shorter than the
        # flush timeout (15s), so the periodic timer can invoke flush()
        # again while a slow drain from a prior call is still running.
        # Without this, two threads could both snapshot+drain the buffer,
        # writing duplicate batches to Influx. A non-blocking acquire
        # means the second caller returns immediately instead of queuing
        # up behind the first (which would also stall the event loop's
        # asyncio.to_thread call for longer than necessary).
        self._flushing = threading.Lock()
        self._load()

    @property
    def buffered(self) -> int:
        with self._lock:
            return len(self._buf)

    def pending(self) -> list[dict]:
        with self._lock:
            return list(self._buf)

    def add(self, ev: Event) -> None:
        # In-memory only -- must never block on file or network I/O so a
        # slow Influx write or fsync can't stall UDP ingest on the event
        # loop. Lock acquisition here is uncontended almost always and
        # only ever guards a pure in-memory append, so it stays cheap.
        with self._lock:
            self._buf.append(event_to_point(ev))
            self._dirty = True

    def flush(self, max_points: int = 10_000, time_budget: float = 5.0) -> bool:
        """Drain the buffer in `self._batch`-sized writes, looping within
        this one call until either the buffer is empty or a bound is hit.

        A single 200-point batch per call (the old behavior) caps history
        throughput at batch/flush_seconds events/sec regardless of how far
        behind the buffer is -- a real burst (or a recovering outage) would
        pile up against the 10,000-slot maxlen and silently drop the
        oldest, invisibly, while flush() kept returning True. Looping here
        lets one flush cycle catch up fully. It is still bounded, by both a
        point count (max_points, default equal to max_buffer so a full
        buffer can drain in one go) and a wall-clock budget (time_budget),
        so a pathological backlog cannot monopolize the thread this runs
        on forever."""
        if not self._flushing.acquire(blocking=False):
            # Another flush() is already draining. Nothing failed here --
            # the in-flight call owns the drain and will persist state --
            # so report success rather than blocking or erroring.
            return True
        try:
            return self._flush_locked(max_points, time_budget)
        finally:
            self._flushing.release()

    def _flush_locked(self, max_points: int, time_budget: float) -> bool:
        with self._lock:
            has_buffered = bool(self._buf)
            dirty = self._dirty
        if not has_buffered:
            if not dirty:
                return True
            return self._persist()

        start = time.monotonic()
        written = 0
        while written < max_points:
            if written > 0 and (time.monotonic() - start) >= time_budget:
                break
            # Select AND remove the batch atomically under one lock
            # acquisition. This is the fix for the over-pop bug: with a
            # separate snapshot-then-popleft(count) sequence, a
            # concurrent add() that triggers a maxlen eviction between
            # the two steps could mean the N items now at the front are
            # not the N items we snapshotted, so popping "however many we
            # wrote" removes the wrong (newer, unwritten) points. Doing
            # both in the same critical section means what we selected
            # to write IS exactly what left the deque -- no gap for
            # add() to land in.
            with self._lock:
                n = min(len(self._buf), self._batch)
                if n == 0:
                    break
                points = [self._buf.popleft() for _ in range(n)]
            try:
                self._writer.write(points)
            except Exception:
                # Write failed -- put the batch back at the front, in
                # original order, so a transient Influx outage doesn't
                # lose it. Subject to the same maxlen drop-oldest rule as
                # any other insert if the buffer filled back up while we
                # were writing.
                with self._lock:
                    self._buf = deque(points + list(self._buf),
                                       maxlen=self._buf.maxlen)
                    self._dirty = True
                self.healthy = False
                self._persist()
                return False
            written += len(points)
            with self._lock:
                self._dirty = True
            self.healthy = True
        return self._persist()

    def _persist(self) -> bool:
        # Write-to-temp + fsync + atomic rename. The fsync before rename
        # matters: without it, a power loss right after os.replace() can
        # still leave the visible file with data that never reached the
        # platter, because the OS is free to delay the write-back of file
        # contents independently of the (already-durable) rename of the
        # directory entry. The rename alone only protects against a
        # *torn/partial write* being observed (readers only ever see the
        # old complete file or the new complete file, never a half-written
        # one) — it does not by itself guarantee the new file's bytes are
        # durable yet.
        #
        # Everything here is wrapped so it can NEVER propagate: this method
        # runs on every flush() call, and flush() must never raise into the
        # live path. It is most likely to fail (disk full, permission
        # error) exactly when the buffer is largest — during a sustained
        # outage — which is precisely when a crash here would be worst.
        # Snapshot under the lock, then do all file I/O outside it -- a
        # slow fsync must never be able to block add() on the event loop.
        # This snapshot is also what fixes the Critical: the old code
        # iterated self._buf directly here with a plain `for`, which
        # raises RuntimeError the instant a concurrent add() mutates the
        # deque mid-iteration. Iterating a plain list snapshot instead is
        # immune to that regardless of what add() does afterward.
        with self._lock:
            snapshot = list(self._buf)

        directory = os.path.dirname(self._path) or "."
        tmp = self._path + ".tmp"
        try:
            os.makedirs(directory, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                for p in snapshot:
                    fh.write(json.dumps(p) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._path)
        except OSError:
            self.healthy = False
            # Best-effort cleanup so a repeatedly failing persist (e.g.
            # disk full every tick) doesn't litter the directory with
            # half-written .tmp files.
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return False

        # Best-effort fsync of the containing directory so the rename
        # itself (the directory entry pointing at the new inode) is
        # durable, not just the file content. Some platforms/filesystems
        # don't support fsync on a directory fd, so failures here are
        # ignored rather than propagated — the file content is already
        # safely written and renamed at this point either way.
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass

        with self._lock:
            self._dirty = False
        return True

    def _load(self) -> None:
        # Startup must never fail because of a stale buffer file. A process
        # that died mid-_persist() (before the atomic rename completed)
        # cannot leave a torn file behind thanks to os.replace(), but the
        # file on disk could still predate this code, be hand-edited, hit
        # disk/bitrot corruption, or contain non-UTF-8 bytes, so tolerate
        # bad content defensively rather than let one bad record take down
        # the whole service. errors="replace" keeps line iteration itself
        # from raising UnicodeDecodeError on invalid byte sequences; any
        # resulting mangled line then simply fails JSON parsing below and
        # is dropped like any other corrupt line.
        try:
            if not os.path.exists(self._path):
                return
            dropped_any = False
            with open(self._path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        dropped_any = True
                        continue
                    if not _is_valid_point(obj):
                        dropped_any = True
                        continue
                    self._buf.append(obj)
            if dropped_any:
                # In-memory state now differs from the on-disk file (bad
                # lines were dropped); the next persist should rewrite the
                # file clean rather than silently staying out of sync.
                self._dirty = True
        except OSError:
            # Can't read the buffer file at all (permissions, race with
            # deletion, etc). Starting empty is strictly better than
            # failing to start.
            self.healthy = False
