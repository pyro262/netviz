"""Is there a newer release than the one this collector is running.

Off unless `NETVIZ_UPDATE_REPO` names a repository: the check is one outbound
HTTPS request the collector did not previously make, and a wall display on an
isolated network should not start talking to the internet because it was
upgraded. Nothing about the network goes with the request -- it is an
unauthenticated GET of a public release list -- but it is new traffic, so it
is opt-in.

The polling shape follows aurora.KpCache, for the same reasons: a thread, so a
hung upstream cannot stall the event loop, and a failed poll retried sooner
than the ordinary interval rather than waiting the full period to notice a
recovery.
"""
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Optional

log = logging.getLogger("netviz")

API = "https://api.github.com/repos/{repo}/releases/latest"

# GitHub's unauthenticated limit is 60 requests an hour per address. At six
# hours this is four a day, so the interval is set by how often a release
# plausibly appears, not by the limit.
POLL_SECONDS = 6 * 3600.0
RETRY_SECONDS = 15 * 60.0
TIMEOUT = 10.0

_NUMBER = re.compile(r"\d+")


def parse_version(text: str) -> Optional[tuple[int, ...]]:
    """`"v1.2.3"` -> `(1, 2, 3)`, or None if there is no version in it.

    Pre-release suffixes are dropped rather than ordered: `1.2.3-rc1` compares
    equal to `1.2.3`, so a release candidate never tells a kiosk it is behind.
    Getting that ordering right matters only to someone publishing RCs, and
    guessing at it would be a silent wrong answer on a wall.
    """
    if not isinstance(text, str):
        return None
    head = text.strip().lstrip("vV").split("-", 1)[0].split("+", 1)[0]
    parts = _NUMBER.findall(head)
    if not parts:
        return None
    return tuple(int(p) for p in parts[:3])


def is_newer(latest: str, current: str) -> bool:
    """True only when `latest` is strictly ahead of `current`.

    False on equal, on either being unparseable, and on `current` being ahead:
    a collector in front of the published release is somebody's working copy,
    and telling them to upgrade to what they already passed is noise.
    """
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    # Zero-padded so (0, 3) and (0, 3, 0) compare equal rather than by length.
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def fetch_latest(repo: str, opener=urllib.request.urlopen) -> Optional[str]:
    """The newest release tag for `repo`, or None on any failure.

    None rather than an exception: every caller's response to "could not ask
    GitHub" is the same as to "no release found" -- say nothing on the wall.
    """
    url = API.format(repo=repo)
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "netviz",
    })
    try:
        with opener(req, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log.warning("release check: %s", e)
        return None
    tag = payload.get("tag_name")
    return tag if isinstance(tag, str) and tag else None


class ReleaseCache:
    """Latest known release tag, refreshed on a background thread.

    `available()` is what the kiosk sees, and it is False in every uncertain
    case. A wall that cannot reach GitHub must look exactly like a wall that is
    up to date -- the opposite (an indicator that appears when the network
    breaks) trains everyone to ignore it.
    """

    def __init__(self, repo: str, current: str, clock=time.time) -> None:
        self.repo = repo
        self.current = current
        self._clock = clock
        self._lock = threading.Lock()
        self._latest: Optional[str] = None
        self._checked: Optional[float] = None

    @property
    def latest(self) -> Optional[str]:
        with self._lock:
            return self._latest

    def available(self) -> bool:
        with self._lock:
            latest = self._latest
        return latest is not None and is_newer(latest, self.current)

    def state(self) -> dict:
        """What rides /build.json. `available` is the only field the renderer
        needs; the rest is for a human reading the endpoint directly."""
        with self._lock:
            latest, checked = self._latest, self._checked
        return {
            "current": self.current,
            "latest": latest,
            "available": latest is not None and is_newer(latest, self.current),
            "checked": checked,
        }

    def refresh(self, opener=urllib.request.urlopen) -> bool:
        """One poll. Returns whether it succeeded, so the caller can retry
        sooner than the ordinary interval."""
        tag = fetch_latest(self.repo, opener=opener)
        if tag is None:
            return False
        with self._lock:
            first = self._latest is None
            self._latest = tag
            self._checked = self._clock()
        if first or is_newer(tag, self.current):
            log.info("release check: latest %s, running %s%s", tag,
                     self.current,
                     " -- update available" if is_newer(tag, self.current) else "")
        return True

    def start(self) -> threading.Thread:
        """Poll forever on a daemon thread.

        A thread rather than an asyncio task because urllib is blocking: a
        GitHub that accepts the connection and then never answers would hold
        the event loop for the whole timeout, stalling UDP reads and every
        kiosk's socket along with it.
        """
        def loop() -> None:
            while True:
                ok = self.refresh()
                time.sleep(POLL_SECONDS if ok else RETRY_SECONDS)

        thread = threading.Thread(target=loop, name="release-check", daemon=True)
        thread.start()
        return thread
