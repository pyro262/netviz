import pathlib
import pytest
from netviz.syslog_parse import parse_syslog_line

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "syslog_block.txt"
LINES = FIXTURE.read_text().splitlines()


def test_parses_tcp_block_line():
    ev = parse_syslog_line(LINES[0])
    assert ev is not None
    assert ev.kind == "block"
    assert ev.src_ip == "203.0.113.9"
    assert ev.dst_ip == "192.168.0.50"
    assert ev.proto == 6
    assert ev.bytes == 60
    assert ev.policy_id == "UBIOS_CUSTOM1_WAN_USER-BLOCK"


def test_parses_udp_block_line():
    ev = parse_syslog_line(LINES[1])
    assert ev is not None
    assert ev.proto == 17
    assert ev.policy_id == "GEO-BLOCK-IN"


def test_ignores_non_firewall_lines():
    assert parse_syslog_line(LINES[2]) is None


def test_ignores_line_missing_src():
    assert parse_syslog_line("<4>kernel: [X] IN=eth8 DST=192.168.0.1 PROTO=TCP") is None


def test_unknown_proto_name_falls_back_to_zero():
    line = "<4>kernel: [X] SRC=1.2.3.4 DST=5.6.7.8 PROTO=ESP LEN=10"
    ev = parse_syslog_line(line)
    assert ev is not None and ev.proto == 0


def test_policy_id_is_none_when_no_bracket_prefix():
    line = "<4>kernel: SRC=1.2.3.4 DST=5.6.7.8 PROTO=TCP LEN=10"
    ev = parse_syslog_line(line)
    assert ev is not None and ev.policy_id is None


def test_skips_kernel_uptime_stamp_takes_rule_prefix():
    """Kernel syslog may include [uptime] before the rule prefix [RULE].
    Parser must skip numeric bracket groups and capture the rule name."""
    ev = parse_syslog_line(LINES[3])
    assert ev is not None
    assert ev.policy_id == "UBIOS_GEO_BLOCK_OUT"


def test_ignores_uptime_only_prefix():
    """If the only bracket group is an uptime stamp, policy_id should be None."""
    line = "<4>kernel: [12345.678] IN=eth8 SRC=1.2.3.4 DST=5.6.7.8 PROTO=TCP LEN=10"
    ev = parse_syslog_line(line)
    assert ev is not None and ev.policy_id is None


def test_rejects_invalid_src_ip():
    """Non-IP values in SRC= should cause the line to be rejected."""
    line = "<4>kernel: [X] SRC=notanip DST=192.168.0.1 PROTO=TCP LEN=10"
    assert parse_syslog_line(line) is None


def test_rejects_malformed_src_ip():
    """Malformed IP values like '1.2.3.4=x' should cause rejection."""
    line = "<4>kernel: [X] SRC=1.2.3.4=x DST=192.168.0.1 PROTO=TCP LEN=10"
    assert parse_syslog_line(line) is None


def test_parses_ipv6_addresses():
    """Valid IPv6 addresses in SRC=/DST= should parse successfully."""
    line = "<4>kernel: [X] SRC=2001:db8::1 DST=2001:db8::2 PROTO=TCP LEN=60"
    ev = parse_syslog_line(line)
    assert ev is not None
    assert ev.src_ip == "2001:db8::1"
    assert ev.dst_ip == "2001:db8::2"


def test_prefers_descr_over_ambiguous_bracket_index():
    """The UDM's NFLOG prefix carries both an index and the real policy name:
      [CUSTOM1_WAN-D-10000] DESCR="Block Secure Zone to Geo Outbound"
    The index is shared by 13 policies (verified on the router 2026-08-07), so the
    DESCR value is the only unambiguous identifier."""
    line = ('<4>kernel: [CUSTOM1_WAN-D-10000] DESCR="Block Secure Zone to Geo Outbound" '
            'IN=br0 OUT=eth8 SRC=192.168.0.46 DST=202.64.0.1 PROTO=UDP LEN=1308')
    ev = parse_syslog_line(line)
    assert ev is not None
    assert ev.policy_id == "Block Secure Zone to Geo Outbound"


def test_falls_back_to_bracket_when_no_descr():
    """Lines without a DESCR= must keep the existing bracket behaviour."""
    line = "<4>kernel: [UBIOS_GEO_BLOCK_OUT] SRC=1.2.3.4 DST=5.6.7.8 PROTO=TCP LEN=10"
    ev = parse_syslog_line(line)
    assert ev is not None and ev.policy_id == "UBIOS_GEO_BLOCK_OUT"


def test_ports_are_parsed_from_spt_dpt():
    line = ('<4>Aug  9 12:00:00 UDM kernel: [123.4] [CUSTOM1_WAN-D-10000] '
            'DESCR="Block Geo" IN=eth8 OUT= SRC=203.0.113.9 DST=192.168.0.5 '
            'LEN=60 PROTO=UDP SPT=41234 DPT=53')
    ev = parse_syslog_line(line)
    assert ev is not None
    assert ev.src_port == 41234
    assert ev.dst_port == 53


def test_missing_ports_stay_none():
    line = ('<4>Aug  9 12:00:00 UDM kernel: [CUSTOM1_WAN-D-10000] '
            'SRC=203.0.113.9 DST=192.168.0.5 LEN=60 PROTO=ICMP')
    ev = parse_syslog_line(line)
    assert ev is not None
    assert ev.src_port is None and ev.dst_port is None
