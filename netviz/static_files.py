"""Serve the kiosk page over the same port as the WebSocket.

websockets' process_request hook may return an HTTP response instead of
continuing to the upgrade; returning None continues normally. That is the
whole mechanism -- no aiohttp, no second port, no extra dependency."""
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import unquote

from websockets.datastructures import Headers
from websockets.http11 import Response

log = logging.getLogger("netviz")

# Explicit rather than mimetypes: the set is fixed and the stdlib table
# varies between hosts and container images.
_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".bin": "application/octet-stream",
    ".ico": "image/x-icon",
}


def build_stamp(root: Path, extra: str = "") -> str:
    """Fingerprint of everything this server would serve.

    The kiosk polls /build.json and reloads when this changes, so a rebuild
    reaches a wall display nobody walks over to. Derived from file names, sizes
    and mtimes rather than a per-process token on purpose: a bare restart
    (watchtower, host reboot, a crash loop) must not bounce every kiosk -- only
    an actual asset change should. Content hashing would be stricter, but this
    walks 2.7 MB of vendored three.js every 30 seconds and stat() is enough to
    catch a docker build.

    `extra` folds in state that is served but is not a file on disk -- the
    display config, which comes from the environment. Without it, changing a
    highlighted network's colour in .env and restarting leaves every open kiosk
    showing the old palette forever: the page reads /config.json once at boot,
    and nothing on disk changed, so no reload is ever triggered. A wall display
    has nobody standing at it to press F5.
    """
    root = Path(root).resolve()
    parts = []
    for path in sorted(root.rglob("*")):
        if path.suffix not in _TYPES or not path.is_file():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        parts.append(f"{path.relative_to(root)}:{st.st_size}:{st.st_mtime_ns}")
    if extra:
        parts.append(f"config:{extra}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def file_etag(path: Path) -> Optional[str]:
    """Validator for one served file, from the same size+mtime basis as the
    build stamp. Content hashing would be stricter but this is computed on every
    request for every asset, and stat() already catches a docker build."""
    try:
        st = path.stat()
    except OSError:
        return None
    raw = f"{path.name}:{st.st_size}:{st.st_mtime_ns}"
    return '"' + hashlib.sha256(raw.encode()).hexdigest()[:20] + '"'


def make_process_request(
    root: Path,
    health: Any = None,
    clock: Callable[[], float] = time.time,
    kp_cache: Any = None,
    stats: Any = None,
    display_config: Any = None,
    release: Any = None,
) -> Callable[[Any, Any], Optional[Response]]:
    """`health` is the collector's Health object, or None.

    None means this build serves no /health.json and the path 404s. The kiosk
    distinguishes that from a 200: a 404 is "no endpoint here", which must not
    be reported on the wall as a dead feed. `stats` works the same way for
    /stats.json, which is what the optional right rail reads.
    """
    root = Path(root).resolve()
    # Serialised once: it cannot change without a restart, and it is hashed on
    # every /build.json poll from every kiosk.
    config_stamp = json.dumps(display_config, sort_keys=True) if display_config else ""

    def _json(method: str, payload: dict) -> Response:
        body = json.dumps(payload).encode()
        return Response(200, "OK", Headers({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-store",
        }), b"" if method == "HEAD" else body)

    def process_request(connection: Any, request: Any) -> Optional[Response]:
        # Anything asking to upgrade belongs to the WebSocket handler.
        if "Upgrade" in request.headers:
            return None

        method = getattr(request, "method", "GET")
        if method not in ("GET", "HEAD"):
            return connection.respond(405, "method not allowed\n")

        raw = unquote(request.path.split("?", 1)[0].split("#", 1)[0])

        # Computed, not read off disk -- handled before the file lookup so no
        # build.json can ever shadow it.
        if raw == "/build.json":
            payload = {"stamp": build_stamp(root, config_stamp)}
            # Rides the reload poll rather than getting an endpoint and a timer
            # of its own: every kiosk already asks for this every 30s, and an
            # update is available for days once it is available at all.
            if release is not None:
                payload["update"] = release.state()
            return _json(method, payload)

        # Same reasoning as build.json: computed before the file lookup so a
        # file of that name on disk cannot shadow the live answer.
        if raw == "/health.json":
            if health is None:
                return connection.respond(404, "not found\n")
            now = clock()
            return _json(method, {"feeds": health.status(now), "now": now})

        # Live geomagnetic activity for the aurora. 404 without a cache, for
        # the same reason health.json does: "this build has no endpoint" is not
        # "the sky is quiet".
        if raw == "/aurora.json":
            if kp_cache is None:
                return connection.respond(404, "not found\n")
            return _json(method, kp_cache.state(clock()))

        # Display settings the collector owns rather than the tracked
        # config.js: the highlighted networks, whose address prefixes describe
        # somebody's LAN layout and so belong in .env, not in a public repo.
        # An empty object rather than a 404 when nothing is configured -- the
        # page must be able to tell "no networks highlighted" from "this build
        # is too old to have the endpoint", and both are normal.
        if raw == "/config.json":
            return _json(method, display_config if display_config is not None else {})

        # The right rail's feed. Carries the health block too, so a rail kiosk
        # makes one request per tick rather than two for the same information.
        if raw == "/stats.json":
            if stats is None:
                return connection.respond(404, "not found\n")
            now = clock()
            payload = stats.snapshot(now)
            payload["feeds"] = health.status(now) if health is not None else None
            return _json(method, payload)

        rel = raw.lstrip("/") or "index.html"
        target = (root / rel).resolve()

        # resolve() collapses ../ and symlinks; the containment check is what
        # makes traversal impossible rather than merely inconvenient.
        if target != root and root not in target.parents:
            log.warning("static: refusing path outside root: %s", raw)
            return connection.respond(403, "forbidden\n")

        content_type = _TYPES.get(target.suffix)
        if content_type is None or not target.is_file():
            return connection.respond(404, "not found\n")

        # `no-cache` and not `no-store`, with a validator.
        #
        # `no-store` forbids keeping the bytes at all, so every kiosk reload
        # re-downloaded and re-compiled the whole page -- 650 KB of vendored
        # three.js, the textures, the star catalogue -- before it could paint a
        # single frame. A reload is exactly when the browser has stopped drawing
        # the old page, so that gap is a visible flash of empty surface on the
        # wall. `no-cache` still forces a revalidation on every request, so a
        # deploy can never be served stale JS; it just lets an unchanged asset
        # come back as a 304 with no body, and lets the JS engine keep its
        # compilation cache for that URL.
        etag = file_etag(target)
        if etag is not None and request.headers.get("If-None-Match") == etag:
            return Response(304, "Not Modified", Headers({
                "ETag": etag,
                "Cache-Control": "no-cache",
            }), b"")

        try:
            body = target.read_bytes()
        except OSError:
            log.exception("static: could not read %s", target)
            return connection.respond(404, "not found\n")

        fields = {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache",
        }
        if etag is not None:
            fields["ETag"] = etag
        return Response(200, "OK", Headers(fields), b"" if method == "HEAD" else body)

    return process_request
