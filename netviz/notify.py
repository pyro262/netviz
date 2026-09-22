"""Webhook posting for stale-feed alerts.

Alerting is **off unless a webhook is configured**, and nothing in this
module knows anything about the install running it. The webhook comes from
one of two places, checked in this order:

  NETVIZ_WEBHOOK_URL    the webhook itself
  NETVIZ_WEBHOOK_FILE   a path to a file holding it, read at call time, with
                        NETVIZ_WEBHOOK_KEY naming the KEY= line to read
                        (default NETVIZ_WEBHOOK_URL)

The file form exists because a value in the environment is visible to
anything that can read the container's config -- `docker inspect` prints it
in full. A file is read only when a message is actually being sent, so the
secret never enters the process environment at all, and a host that already
keeps a webhook somewhere for another tool can point at that file rather
than copying the value.

Two URL shapes are accepted, because the two ways people already have one
differ: the `https://discord.com/api/webhooks/<id>/<token>` that Discord's
own channel settings hand out, and the shoutrrr `discord://<token>@<id>`
that Watchtower and friends consume. The second is converted to the first --
note that the id and token reverse.
"""
import json
import logging
import os
import urllib.request

from . import __version__

MAX_CONTENT = 2000
# Discord sits behind Cloudflare, which refuses urllib's default
# `Python-urllib/3.x` outright: measured 403 with body `error code: 1010`,
# against a webhook that answers 204 to the identical request carrying this
# header. Nothing about the payload or the token was ever wrong, so the
# failure looked exactly like a dead webhook. Do not drop this header.
USER_AGENT = f"netviz-collector/{__version__}"
_SCHEME = "discord://"

logger = logging.getLogger(__name__)


def _env(name: str, default: str = "") -> str:
    """Read an env var at call time, not at import.

    Tests reload this module to change its configuration; reading at call
    time means they do not have to, and means an operator who corrects a
    typo does not need the value to have been right at boot.
    """
    return os.environ.get(name, default).strip()


def configured() -> bool:
    """True when a webhook is configured at all.

    The caller uses this to stay silent rather than to fail: an install that
    has set nothing must make no outbound request and log no traceback. It
    reports only that *something* is configured -- a malformed value is a
    real error and is raised by resolve_webhook(), because a webhook someone
    meant to set and got wrong must not look the same as one they declined.
    """
    return bool(_env("NETVIZ_WEBHOOK_URL") or _env("NETVIZ_WEBHOOK_FILE"))


def _read_from_file(path: str) -> str:
    """Pull the webhook out of a KEY=VALUE file.

    Tolerates a quoted value, a trailing CRLF, and a commented-out or
    duplicated key (last occurrence wins), because the file is often one
    another tool owns and this must not be fussy about its formatting.
    """
    key = _env("NETVIZ_WEBHOOK_KEY") or "NETVIZ_WEBHOOK_URL"
    prefix = f"{key}="
    raw = ""
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith(prefix):
                value = stripped.split("=", 1)[1].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                raw = value  # last occurrence wins on a duplicate key
    if not raw:
        raise RuntimeError(f"{key} not found in {path}")
    return raw


def resolve_webhook() -> str:
    """Return the POSTable webhook URL.

    Raises RuntimeError -- never returns a half-built URL -- when the value
    is missing or is not one of the two accepted shapes. Error messages name
    the variable and the path, never the value itself.
    """
    raw = _env("NETVIZ_WEBHOOK_URL")
    source = "NETVIZ_WEBHOOK_URL"
    if not raw:
        path = _env("NETVIZ_WEBHOOK_FILE")
        if not path:
            raise RuntimeError(
                "no webhook configured: set NETVIZ_WEBHOOK_URL or "
                "NETVIZ_WEBHOOK_FILE")
        raw = _read_from_file(path)
        source = path

    if raw.startswith(_SCHEME):
        body = raw[len(_SCHEME):]
        token, sep, webhook_id = body.partition("@")
        if not sep or not token or not webhook_id:
            raise RuntimeError(
                f"the webhook in {source} is missing a token or webhook id")
        return f"https://discord.com/api/webhooks/{webhook_id}/{token}"

    if raw.startswith("https://"):
        return raw

    raise RuntimeError(
        f"the webhook in {source} is neither an https:// URL nor a "
        f"{_SCHEME} address")


def _build_payload(message: str) -> bytes:
    """Truncate to Discord's content cap and encode the JSON body.
    Split out from post() so truncation can be unit tested without
    performing any network I/O."""
    return json.dumps({"content": message[:MAX_CONTENT]}).encode()


def post(message: str) -> bool:
    """POST one message. False on any failure; never raises.

    Returns False when no webhook is configured, which is the ordinary state
    of an install that never wanted alerts -- callers check configured()
    once at boot so this path stays quiet rather than logging every 30s.
    """
    if not configured():
        return False
    body = _build_payload(message)
    req = urllib.request.Request(
        resolve_webhook(), data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ok = 200 <= resp.status < 300
            if not ok:
                logger.warning("webhook post failed: HTTP status %s", resp.status)
            return ok
    except Exception as exc:
        # urllib exceptions can embed the full request URL (and therefore the
        # webhook token) in their str(). Log only the exception type name and
        # a static message — never the exception message or the URL/body.
        logger.warning(
            "webhook post failed with %s; see network conditions on this host",
            type(exc).__name__,
        )
        return False
