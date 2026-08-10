"""Recent-event buffer replayed to each newly connected kiosk.

Stores pre-serialized JSON -- exactly the text ws_handler sends -- so a
snapshot goes straight to the socket with no re-serialization. Measured on
this host: 204 B/event -- 2.9 MiB for the original 15-minute window at the
observed live rate, ~0.8 MiB for the 60-second one now in use.

Bounded by count AND age on purpose: maxlen alone would retain hours of a
quiet night, and the age window alone would be unbounded during a flood."""
import collections
import json
import logging
from typing import Deque, Tuple

log = logging.getLogger("netviz")


class Replay:
    # 60s, not the original 900s: a kiosk reload received the entire window at
    # once, so the renderer's 220-arc pool churned hard for several seconds
    # before settling. A minute is enough to show the wall is live. The count
    # bound is sized above 60s at the observed live rate (~57 events/sec) so the
    # age bound is the one that actually decides the window.
    def __init__(self, max_events: int = 4_000, window_seconds: float = 60.0) -> None:
        self._items: Deque[Tuple[float, str]] = collections.deque(maxlen=max_events)
        self._window = window_seconds

    def __len__(self) -> int:
        return len(self._items)

    def add(self, ev) -> None:
        # Called from on_event after fanout.broadcast, so a failure here must
        # never surface: the live arc has already gone out.
        try:
            self._items.append((ev.ts, json.dumps(ev.to_wire())))
        except Exception:
            log.exception("replay: could not store event, continuing")

    def snapshot(self, now: float) -> list[str]:
        # <= not <: an event exactly window_seconds old is already outside the
        # window, so it goes. Keeps the boundary from lingering a frame.
        cutoff = now - self._window
        while self._items and self._items[0][0] <= cutoff:
            self._items.popleft()
        return [payload for _, payload in self._items]
