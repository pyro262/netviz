"""IPFIX v10 decoder (RFC 7011). Templates are cached per observation domain;
data records arriving before their template are dropped and counted."""
import ipaddress
import json
import logging
import struct
import time
from pathlib import Path
from typing import Optional

from .events import Event

log = logging.getLogger("netviz")

HEADER = struct.Struct("!HHIII")
SET_HEADER = struct.Struct("!HH")

# Information Element IDs we care about (IANA IPFIX registry).
IE_OCTETS = 1
IE_PROTOCOL = 4
IE_SRC_PORT = 7
IE_SRC_IPV4 = 8
IE_DST_PORT = 11
IE_DST_IPV4 = 12
IE_SRC_IPV6 = 27
IE_DST_IPV6 = 28
IE_OCTETS_64 = 85

VARIABLE_LENGTH = 0xFFFF


class IpfixDecoder:
    def __init__(self, template_path=None) -> None:
        # (domain_id, template_id) -> list of (ie_id, length)
        self._templates: dict[tuple[int, int], list[tuple[int, int]]] = {}
        self.stats = {"messages": 0, "templates": 0, "records": 0,
                      "no_template": 0, "malformed": 0, "bad_records": 0}
        # Without this, templates are memory-only and every restart drops data
        # records until the router's next template set -- ~50 at refresh_rate
        # 10, proportionally worse if that is raised. None disables the file
        # entirely, which is what the tests and synthetic mode use.
        self._template_path = Path(template_path) if template_path else None
        if self._template_path:
            self._load_templates()

    def _load_templates(self) -> None:
        """Never fatal. A missing, truncated or hand-edited file just means a
        cold start -- exactly the behaviour before this existed."""
        try:
            raw = json.loads(self._template_path.read_text())
            saved = raw["templates"]
        except FileNotFoundError:
            return
        except (OSError, ValueError, KeyError, TypeError) as err:
            log.warning("ipfix: ignoring unreadable template cache %s: %s",
                        self._template_path, err)
            return

        loaded = {}
        try:
            for key, fields in saved.items():
                domain, tid = key.split(":")
                loaded[(int(domain), int(tid))] = [(int(ie), int(ln)) for ie, ln in fields]
        except (AttributeError, ValueError, TypeError) as err:
            log.warning("ipfix: template cache %s has the wrong shape: %s",
                        self._template_path, err)
            return
        self._templates = loaded
        log.info("ipfix: loaded %d cached templates from %s",
                 len(loaded), self._template_path)

    def _save_templates(self) -> None:
        """Atomic replace: a kiosk restart mid-write must not leave a partial
        file that the next start then discards."""
        payload = {"v": 1, "templates": {
            f"{d}:{t}": [list(f) for f in fields]
            for (d, t), fields in self._templates.items()
        }}
        tmp = self._template_path.with_suffix(".tmp")
        try:
            self._template_path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload))
            tmp.replace(self._template_path)
        except OSError as err:
            # A read-only or full /state must not stop the collector decoding.
            log.warning("ipfix: could not persist templates to %s: %s",
                        self._template_path, err)

    def decode(self, datagram: bytes) -> list[Event]:
        try:
            return self._decode(datagram)
        except (struct.error, IndexError, ValueError):
            self.stats["malformed"] += 1
            return []

    def _decode(self, datagram: bytes) -> list[Event]:
        if len(datagram) < HEADER.size:
            raise ValueError("short header")
        version, length, export_time, _seq, domain = HEADER.unpack_from(datagram, 0)
        if version != 10:
            raise ValueError(f"not IPFIX: version {version}")
        if length > len(datagram):
            raise ValueError("truncated message")

        self.stats["messages"] += 1
        events: list[Event] = []
        off = HEADER.size
        while off + SET_HEADER.size <= length:
            set_id, set_len = SET_HEADER.unpack_from(datagram, off)
            if set_len < SET_HEADER.size or off + set_len > length:
                # Can't trust any further offsets in this message once a set
                # header lies about its own length, but sets already decoded
                # (and their events) are real and must not be discarded.
                self.stats["malformed"] += 1
                break
            body = datagram[off + SET_HEADER.size: off + set_len]
            try:
                if set_id == 2:
                    self._read_templates(domain, body)
                elif set_id == 3:
                    pass          # options templates carry no flow data for us
                elif set_id >= 256:
                    events.extend(self._read_data(domain, set_id, body, export_time))
            except (struct.error, IndexError, ValueError):
                # A malformed set must not cost us events already decoded
                # from earlier sets in this same message.
                self.stats["malformed"] += 1
            off += set_len
        return events

    def _read_templates(self, domain: int, body: bytes) -> None:
        off = 0
        while off + 4 <= len(body):
            tid, count = struct.unpack_from("!HH", body, off)
            off += 4
            fields: list[tuple[int, int]] = []
            try:
                for _ in range(count):
                    if off + 4 > len(body):
                        raise ValueError("truncated template field")
                    ie, ln = struct.unpack_from("!HH", body, off)
                    off += 4
                    if ie & 0x8000:           # enterprise-specific: skip the PEN
                        if off + 4 > len(body):
                            raise ValueError("truncated enterprise PEN")
                        ie &= 0x7FFF
                        off += 4
                    fields.append((ie, ln))
            except (struct.error, ValueError):
                # Can't reliably find the next template record in this set
                # once one is truncated, but templates already cached from
                # earlier in this set (or earlier sets) are still good.
                self.stats["malformed"] += 1
                return
            # Only write when the content actually changed: the router re-sends
            # every template each refresh_rate (10s here), and rewriting the
            # file on each one would be a pointless write forever.
            changed = self._templates.get((domain, tid)) != fields
            self._templates[(domain, tid)] = fields
            self.stats["templates"] += 1
            if changed and self._template_path:
                self._save_templates()

    def _read_data(self, domain: int, tid: int, body: bytes,
                   export_time: int) -> list[Event]:
        fields = self._templates.get((domain, tid))
        if fields is None:
            self.stats["no_template"] += 1
            return []

        # Lower bound on a record's size: every fixed field contributes its
        # full length, every variable field contributes at least the 1-byte
        # length prefix. Anything shorter than this remaining in the set is
        # trailing padding, not a truncated record, and must be discarded
        # silently rather than parsed.
        min_record = sum(1 if ln == VARIABLE_LENGTH else ln for _, ln in fields)
        events: list[Event] = []
        off = 0
        while off + min_record <= len(body):
            start = off
            try:
                values, off = self._read_record(fields, body, off)
            except (struct.error, IndexError, ValueError):
                # A corrupt record makes every subsequent offset in this set
                # unreliable, so stop here — but keep the events already
                # decoded from good records earlier in the set.
                self.stats["bad_records"] += 1
                break
            if off <= start:
                # No forward progress (e.g. a zero-field template) — bail
                # out rather than spin.
                break
            try:
                ev = self._to_event(values, export_time)
            except (struct.error, IndexError, ValueError):
                # Fields parsed fine (offset is trustworthy) but the values
                # can't be turned into an Event — e.g. ip_address() on a
                # field whose template-declared length isn't 4 or 16 bytes.
                # Skip just this record; keep going, don't discard the rest.
                self.stats["bad_records"] += 1
                continue
            if ev is not None:
                self.stats["records"] += 1
                events.append(ev)
        return events

    @staticmethod
    def _read_record(fields: list[tuple[int, int]], body: bytes,
                      off: int) -> tuple[dict[int, bytes], int]:
        values: dict[int, bytes] = {}
        for ie, ln in fields:
            if ln == VARIABLE_LENGTH:
                if off + 1 > len(body):
                    raise ValueError("truncated variable-length prefix")
                ln = body[off]
                off += 1
                if ln == 255:
                    if off + 2 > len(body):
                        raise ValueError("truncated variable-length extension")
                    ln = struct.unpack_from("!H", body, off)[0]
                    off += 2
            if off + ln > len(body):
                raise ValueError("record field runs past end of set")
            values[ie] = body[off: off + ln]
            off += ln
        return values, off

    @staticmethod
    def _int(raw: bytes) -> int:
        return int.from_bytes(raw, "big") if raw else 0

    def _to_event(self, values: dict[int, bytes], export_time: int) -> Optional[Event]:
        src = values.get(IE_SRC_IPV4) or values.get(IE_SRC_IPV6)
        dst = values.get(IE_DST_IPV4) or values.get(IE_DST_IPV6)
        if not src or not dst:
            return None
        octets = values.get(IE_OCTETS) or values.get(IE_OCTETS_64) or b""
        return Event(
            ts=float(export_time or time.time()),
            kind="flow",
            src_ip=str(ipaddress.ip_address(src)),
            dst_ip=str(ipaddress.ip_address(dst)),
            bytes=self._int(octets),
            proto=self._int(values.get(IE_PROTOCOL, b"")),
            src_port=(self._int(values[IE_SRC_PORT])
                      if IE_SRC_PORT in values else None),
            dst_port=(self._int(values[IE_DST_PORT])
                      if IE_DST_PORT in values else None),
        )
