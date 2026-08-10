"""Discord posting. The webhook is read from the shared host file at call time
and never stored anywhere else."""
import json
import logging
import os
import urllib.request

ENV_PATH = os.environ.get("WATCHTOWER_ENV", "/host/watchtower.env")
MAX_CONTENT = 2000
_SCHEME = "discord://"

logger = logging.getLogger(__name__)


def resolve_webhook() -> str:
    """Convert shoutrrr discord://<token>@<id> to the REST endpoint.
    Note the id/token order reverses.

    Tolerates a quoted value, a trailing CRLF, and a commented-out or
    duplicated key (last occurrence wins). Raises RuntimeError — never
    returns a half-built URL — if the value is missing the discord://
    scheme or either the token or webhook id is empty. Error messages
    never include the value itself."""
    raw = None
    with open(ENV_PATH, encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("WATCHTOWER_NOTIFICATION_URL="):
                value = stripped.split("=", 1)[1].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                raw = value  # last occurrence wins on a duplicate key

    if not raw:
        raise RuntimeError(f"WATCHTOWER_NOTIFICATION_URL not found in {ENV_PATH}")
    if not raw.startswith(_SCHEME):
        raise RuntimeError(
            f"WATCHTOWER_NOTIFICATION_URL in {ENV_PATH} does not use the "
            f"{_SCHEME} scheme"
        )

    body = raw[len(_SCHEME):]
    token, sep, webhook_id = body.partition("@")
    if not sep or not token or not webhook_id:
        raise RuntimeError(
            f"WATCHTOWER_NOTIFICATION_URL in {ENV_PATH} is missing a token "
            f"or webhook id"
        )
    return f"https://discord.com/api/webhooks/{webhook_id}/{token}"


def _build_payload(message: str) -> bytes:
    """Truncate to Discord's content cap and encode the JSON body.
    Split out from post() so truncation can be unit tested without
    performing any network I/O."""
    return json.dumps({"content": message[:MAX_CONTENT]}).encode()


def post(message: str) -> bool:
    body = _build_payload(message)
    req = urllib.request.Request(
        resolve_webhook(), data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ok = 200 <= resp.status < 300
            if not ok:
                logger.warning("Discord post failed: HTTP status %s", resp.status)
            return ok
    except Exception as exc:
        # urllib exceptions can embed the full request URL (and therefore the
        # webhook token) in their str(). Log only the exception type name and
        # a static message — never the exception message or the URL/body.
        logger.warning(
            "Discord post failed with %s; see network conditions on this host",
            type(exc).__name__,
        )
        return False
