"""Live WebSocket broadcast. No history, no persistence, no buffering beyond a
small per-client queue: a kiosk that cannot keep up is disconnected, because a
wall display showing a growing backlog is worse than one that reconnects."""
import asyncio
from typing import Any, Hashable

from .events import Event


# Sentinel object to signal client disconnection. Consumers awaiting queue.get()
# will receive this as the last item before the queue is unregistered.
CLOSE = object()


class Fanout:
    def __init__(self, queue_size: int = 256) -> None:
        self._queue_size = queue_size
        self._clients: dict[Hashable, asyncio.Queue] = {}
        # stats["sent"] counts per-client deliveries: a broadcast to three clients
        # increments it by three.
        self.stats = {"sent": 0, "dropped_clients": 0}

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def register(self, key: Hashable) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._clients[key] = q
        return q

    def unregister(self, key: Hashable) -> None:
        self._clients.pop(key, None)

    def broadcast(self, ev: Event) -> None:
        if not self._clients:
            return
        # The wire dict is shared by reference across all clients. Consumers must
        # treat it as read-only.
        wire: dict[str, Any] = ev.to_wire()
        for key in list(self._clients):
            q = self._clients[key]
            try:
                q.put_nowait(wire)
                self.stats["sent"] += 1
            except asyncio.QueueFull:
                self._drain_and_close_client(key)
                self.stats["dropped_clients"] += 1

    def close_client(self, key: Hashable) -> None:
        """Orderly shutdown: drain backlog and send CLOSE sentinel.
        Safe to call for a key that is already unregistered (idempotent)."""
        if key not in self._clients:
            return
        self._drain_and_close_client(key)

    def _drain_and_close_client(self, key: Hashable) -> None:
        """Drain a client's queue and send CLOSE sentinel to wake waiting consumer."""
        q = self._clients[key]
        while not q.empty():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                break
        # Draining guarantees there is room for the sentinel.
        q.put_nowait(CLOSE)
        self.unregister(key)
