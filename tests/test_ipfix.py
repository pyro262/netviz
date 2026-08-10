import struct
import pytest
from netviz.ipfix import IpfixDecoder


def _msg(sets: bytes, seq: int = 1, domain: int = 0, export_time: int = 1754500000) -> bytes:
    """Build an IPFIX message header (RFC 7011 s3.1) around pre-built sets."""
    length = 16 + len(sets)
    return struct.pack("!HHIII", 10, length, export_time, seq, domain) + sets


def _template_set(tid: int = 256) -> bytes:
    """Template for: srcIPv4(8), dstIPv4(12), octets(1), proto(4), srcPort(7), dstPort(11)."""
    fields = b"".join(struct.pack("!HH", ie, ln) for ie, ln in
                      [(8, 4), (12, 4), (1, 8), (4, 1), (7, 2), (11, 2)])
    record = struct.pack("!HH", tid, 6) + fields
    return struct.pack("!HH", 2, 4 + len(record)) + record


def _data_set(tid: int = 256) -> bytes:
    rec = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
           + struct.pack("!Q", 4096) + bytes([6]) + struct.pack("!HH", 44321, 443))
    return struct.pack("!HH", tid, 4 + len(rec)) + rec


def test_data_without_template_is_dropped_and_counted():
    d = IpfixDecoder()
    assert d.decode(_msg(_data_set())) == []
    assert d.stats["no_template"] == 1


def test_template_then_data_yields_flow_event():
    d = IpfixDecoder()
    d.decode(_msg(_template_set()))
    events = d.decode(_msg(_data_set(), seq=2))
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "flow"
    assert ev.src_ip == "203.0.113.9"
    assert ev.dst_ip == "192.168.0.50"
    assert ev.bytes == 4096
    assert ev.proto == 6


def test_template_and_data_in_one_message():
    d = IpfixDecoder()
    events = d.decode(_msg(_template_set() + _data_set()))
    assert len(events) == 1
    assert d.stats["templates"] == 1


def test_non_ipfix_version_is_rejected():
    bad = struct.pack("!HHIII", 9, 16, 0, 0, 0)
    d = IpfixDecoder()
    assert d.decode(bad) == []
    assert d.stats["malformed"] == 1


def test_truncated_datagram_does_not_raise():
    d = IpfixDecoder()
    assert d.decode(_msg(_template_set())[:12]) == []
    assert d.stats["malformed"] == 1


def test_templates_are_scoped_per_observation_domain():
    d = IpfixDecoder()
    d.decode(_msg(_template_set(), domain=1))
    assert d.decode(_msg(_data_set(), domain=2)) == []
    assert d.stats["no_template"] == 1


def _template_set_variable(tid: int, fields) -> bytes:
    """Build a template set from an explicit (ie, len) field list, where
    len == 0xFFFF marks a variable-length field."""
    body = b"".join(struct.pack("!HH", ie, ln) for ie, ln in fields)
    record = struct.pack("!HH", tid, len(fields)) + body
    return struct.pack("!HH", 2, 4 + len(record)) + record


VARLEN = 0xFFFF


def test_good_record_followed_by_malformed_record_keeps_good_events():
    # Template: srcIPv4(4), dstIPv4(4), octets(8), proto(1), varfield(variable).
    # min record size = 4+4+8+1+1 = 18.
    tid = 300
    fields = [(8, 4), (12, 4), (1, 8), (4, 1), (999, VARLEN)]
    good = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
            + struct.pack("!Q", 4096) + bytes([6])
            + bytes([3]) + b"abc")  # short-form varlen: len=3, payload "abc"
    # Malformed: 17 fixed bytes + a varlen prefix of 255 (extended-length
    # marker) with zero bytes left for the required 2-byte extension.
    bad = (bytes([198, 51, 100, 1]) + bytes([192, 168, 0, 51])
           + struct.pack("!Q", 1) + bytes([17]) + bytes([255]))
    assert len(good) == 21
    assert len(bad) == 18  # == min record size, so the loop attempts it
    rec_bytes = good + bad
    body = struct.pack("!HH", tid, 4 + len(rec_bytes)) + rec_bytes
    sets = _template_set_variable(tid, fields) + body

    d = IpfixDecoder()
    events = d.decode(_msg(sets))
    assert len(events) == 1
    assert events[0].src_ip == "203.0.113.9"
    assert d.stats["records"] == 1
    assert d.stats["bad_records"] == 1


def test_variable_length_field_short_form_decodes_value():
    tid = 301
    fields = [(8, 4), (12, 4), (1, VARLEN), (4, 1)]
    rec = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
           + bytes([2]) + struct.pack("!H", 1234)   # short-form len=2, value=1234
           + bytes([6]))
    body = struct.pack("!HH", tid, 4 + len(rec)) + rec
    sets = _template_set_variable(tid, fields) + body

    d = IpfixDecoder()
    events = d.decode(_msg(sets))
    assert len(events) == 1
    assert events[0].bytes == 1234
    assert events[0].proto == 6
    assert d.stats["bad_records"] == 0
    assert d.stats["malformed"] == 0


def test_variable_length_field_extended_255_form_decodes_value():
    tid = 302
    fields = [(8, 4), (12, 4), (1, VARLEN), (4, 1)]
    rec = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
           + bytes([255]) + struct.pack("!H", 3)     # extended: 255 marker + 2-byte len=3
           + bytes([0x01, 0x11, 0x70])                # value = 70000
           + bytes([6]))
    body = struct.pack("!HH", tid, 4 + len(rec)) + rec
    sets = _template_set_variable(tid, fields) + body

    d = IpfixDecoder()
    events = d.decode(_msg(sets))
    assert len(events) == 1
    assert events[0].bytes == 70000
    assert d.stats["bad_records"] == 0
    assert d.stats["malformed"] == 0


def test_trailing_padding_in_data_set_is_discarded_silently():
    d = IpfixDecoder()
    d.decode(_msg(_template_set()))
    rec = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
           + struct.pack("!Q", 4096) + bytes([6]) + struct.pack("!HH", 44321, 443))
    padding = bytes([0, 0, 0])  # shorter than the 21-byte fixed record size
    body = struct.pack("!HH", 256, 4 + len(rec)) + rec + padding
    events = d.decode(_msg(body, seq=2))
    assert len(events) == 1
    assert d.stats["bad_records"] == 0
    assert d.stats["malformed"] == 0


def test_to_event_failure_on_one_record_keeps_other_events_in_set():
    # srcIPv4 declared variable-length so its per-record byte count can differ:
    # a good record supplies 4 bytes (valid), a bad record supplies 3 bytes,
    # which ip_address() cannot parse (not 4 or 16 bytes) and raises inside
    # _to_event *after* _read_record has already succeeded.
    tid = 304
    fields = [(8, VARLEN), (12, 4), (1, 8), (4, 1)]
    good = (bytes([4]) + bytes([203, 0, 113, 9])       # varlen src, 4 bytes
            + bytes([192, 168, 0, 50])                  # dst
            + struct.pack("!Q", 4096) + bytes([6]))      # octets, proto
    bad = (bytes([3]) + bytes([1, 2, 3])                # varlen src, 3 bytes: invalid
           + bytes([192, 168, 0, 51])
           + struct.pack("!Q", 1) + bytes([17]))
    rec_bytes = good + bad
    body = struct.pack("!HH", tid, 4 + len(rec_bytes)) + rec_bytes
    sets = _template_set_variable(tid, fields) + body

    d = IpfixDecoder()
    events = d.decode(_msg(sets))
    assert len(events) == 1
    assert events[0].src_ip == "203.0.113.9"
    assert d.stats["records"] == 1
    assert d.stats["bad_records"] == 1
    assert d.stats["malformed"] == 0


def test_enterprise_specific_field_is_skipped_with_its_pen():
    tid = 303
    # srcIPv4(4), dstIPv4(4), enterprise-specific field (ie=7, high bit set,
    # len=4) with its 4-byte PEN, octets(8), proto(1).
    template_fields = (
        struct.pack("!HH", 8, 4)
        + struct.pack("!HH", 12, 4)
        + struct.pack("!HH", 0x8007, 4) + struct.pack("!I", 12345)
        + struct.pack("!HH", 1, 8)
        + struct.pack("!HH", 4, 1)
    )
    record = struct.pack("!HH", tid, 5) + template_fields
    tmpl_set = struct.pack("!HH", 2, 4 + len(record)) + record

    rec = (bytes([203, 0, 113, 9]) + bytes([192, 168, 0, 50])
           + bytes([0xAA, 0xBB, 0xCC, 0xDD])   # enterprise field value, ignored
           + struct.pack("!Q", 4096) + bytes([6]))
    data_body = struct.pack("!HH", tid, 4 + len(rec)) + rec

    d = IpfixDecoder()
    events = d.decode(_msg(tmpl_set + data_body))
    assert d.stats["templates"] == 1
    assert d.stats["malformed"] == 0
    assert d.stats["bad_records"] == 0
    assert len(events) == 1
    assert events[0].src_ip == "203.0.113.9"
    assert events[0].dst_ip == "192.168.0.50"
    assert events[0].bytes == 4096
    assert events[0].proto == 6


def test_templates_survive_a_restart_when_a_path_is_given(tmp_path):
    """Templates live in memory only, so every collector restart drops data
    records until the router's next template set -- ~50 records at
    refresh_rate 10, and worse if it is raised. Persisting them closes that
    window."""
    path = tmp_path / "templates.json"

    first = IpfixDecoder(template_path=path)
    first.decode(_msg(_template_set()))
    assert path.is_file(), "template set did not reach disk"

    # A fresh decoder, as if the process had restarted -- no template set.
    second = IpfixDecoder(template_path=path)
    events = second.decode(_msg(_data_set()))

    assert len(events) == 1
    assert second.stats["no_template"] == 0


def test_a_corrupt_template_file_is_ignored_rather_than_fatal(tmp_path):
    path = tmp_path / "templates.json"
    path.write_text("{not json at all")

    decoder = IpfixDecoder(template_path=path)          # must not raise

    assert decoder.decode(_msg(_data_set())) == []
    assert decoder.stats["no_template"] == 1


def test_a_template_file_with_the_wrong_shape_is_ignored(tmp_path):
    path = tmp_path / "templates.json"
    path.write_text('{"v": 1, "templates": {"0:256": "not a field list"}}')

    decoder = IpfixDecoder(template_path=path)

    assert decoder.decode(_msg(_data_set())) == []


def test_no_file_is_written_without_a_path(tmp_path):
    decoder = IpfixDecoder()
    decoder.decode(_msg(_template_set()))

    assert list(tmp_path.iterdir()) == []


def test_an_unchanged_template_is_not_rewritten(tmp_path):
    """The router re-sends templates every refresh_rate seconds. Rewriting the
    file on each one would be a pointless write every 10s, forever."""
    path = tmp_path / "templates.json"
    decoder = IpfixDecoder(template_path=path)
    decoder.decode(_msg(_template_set()))
    first = path.stat().st_mtime_ns

    decoder.decode(_msg(_template_set()))               # identical template

    assert path.stat().st_mtime_ns == first


def test_a_changed_template_is_rewritten(tmp_path):
    path = tmp_path / "templates.json"
    decoder = IpfixDecoder(template_path=path)
    decoder.decode(_msg(_template_set()))

    decoder.decode(_msg(_template_set_variable(256, [(8, 4), (12, 4)])))

    from json import loads
    saved = loads(path.read_text())["templates"]["0:256"]
    assert [tuple(f) for f in saved] == [(8, 4), (12, 4)]
