"""Parse netfilter LOG-target syslog lines into block Events.

Deliberately keyed on the SRC=/DST=/PROTO= key-value pairs rather than on
UniFi's rule wording, which is unverified and may change between firmware
versions. Any bracketed prefix becomes policy_id."""
import ipaddress
import re
import time
from typing import Optional

from .events import Event

_KV = re.compile(r"\b([A-Z]+)=(\S*)")
_PREFIX = re.compile(r"\[([^\]]+)\]")
_DESCR = re.compile(r'DESCR="([^"]+)"')
_UPTIME = re.compile(r"^\d+(?:\.\d+)?$")

_PROTO_NUMBERS = {"TCP": 6, "UDP": 17, "ICMP": 1, "ICMPV6": 58}


def _is_uptime_stamp(s: str) -> bool:
    """Check if a string is a kernel uptime stamp (numeric with optional decimal)."""
    return _UPTIME.match(s.strip()) is not None


def _extract_policy_id(line: str) -> Optional[str]:
    """Extract rule policy_id, preferring the UDM's DESCR="..." policy name over the
    bracket index — that index is shared across policies and cannot identify a rule."""
    descr = _DESCR.search(line)
    if descr:
        return descr.group(1)
    for match in _PREFIX.finditer(line):
        candidate = match.group(1)
        if not _is_uptime_stamp(candidate):
            return candidate
    return None


def _validate_ip(ip_str: str) -> bool:
    """Validate that a string is a valid IP address."""
    try:
        ipaddress.ip_address(ip_str)
        return True
    except (ValueError, ipaddress.AddressValueError):
        return False


def parse_syslog_line(line: str) -> Optional[Event]:
    kv = dict(_KV.findall(line))
    src, dst = kv.get("SRC"), kv.get("DST")
    if not src or not dst:
        return None

    # Validate that both src and dst are valid IP addresses
    if not _validate_ip(src) or not _validate_ip(dst):
        return None

    proto = _PROTO_NUMBERS.get(kv.get("PROTO", "").upper(), 0)
    try:
        length = int(kv.get("LEN", "0"))
    except ValueError:
        length = 0

    def _port(key: str) -> Optional[int]:
        try:
            value = int(kv[key])
        except (KeyError, ValueError):
            return None
        return value if 0 <= value <= 65535 else None

    policy_id = _extract_policy_id(line)
    return Event(
        ts=time.time(),
        kind="block",
        src_ip=src,
        dst_ip=dst,
        bytes=length,
        proto=proto,
        policy_id=policy_id,
        src_port=_port("SPT"),
        dst_port=_port("DPT"),
    )
