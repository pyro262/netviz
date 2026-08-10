"""The router's own geo tables.

Fixtures are built here rather than shipped: the real tables are a site's own
file, 2.4 MB of them, and the format is simple enough to write.
"""
import ipaddress
import struct

import pytest

from netviz.xtgeoip import XtGeoIP


def write_v4(path, ranges):
    """ranges: [(start_str, end_str)] -> little-endian uint32 pairs."""
    blob = b"".join(struct.pack("<II", int(ipaddress.ip_address(a)),
                                int(ipaddress.ip_address(b)))
                    for a, b in ranges)
    path.write_bytes(blob)


def write_v6(path, ranges):
    """ranges: [(start_str, end_str)] -> four little-endian uint32 words each.

    Deliberately built the same way the file is read, so the test would not
    catch a matched pair of wrong assumptions -- which is why the plausibility
    check on real data (2000::/3) is in the fetch verification, not only here.
    """
    out = bytearray()
    for a, b in ranges:
        for s in (a, b):
            packed = ipaddress.ip_address(s).packed
            out += struct.pack("<4I", *struct.unpack(">4I", packed))
    path.write_bytes(bytes(out))


@pytest.fixture
def tables(tmp_path):
    write_v4(tmp_path / "HK.iv4", [("103.28.54.0", "103.28.54.255"),
                                   ("1.32.205.0", "1.32.205.255")])
    write_v4(tmp_path / "ZA.iv4", [("155.133.238.0", "155.133.238.255")])
    write_v6(tmp_path / "CN.iv6", [("2001:250::", "2001:250:fff:ffff:ffff:ffff:ffff:ffff")])
    return tmp_path


def test_v4_lookup_hits_inside_a_range(tables):
    x = XtGeoIP.load(str(tables))
    assert x.lookup("198.51.100.167") == "HK"
    assert x.lookup("155.133.238.194") == "ZA"


def test_v4_boundaries_are_inclusive(tables):
    x = XtGeoIP.load(str(tables))
    assert x.lookup("103.28.54.0") == "HK"
    assert x.lookup("103.28.54.255") == "HK"
    assert x.lookup("103.28.53.255") is None
    assert x.lookup("103.28.55.0") is None


def test_an_address_between_two_ranges_is_not_claimed(tables):
    """The bisection lands on the preceding range; its end has to be checked,
    or every address above the lowest range would be claimed by it."""
    x = XtGeoIP.load(str(tables))
    assert x.lookup("100.0.0.1") is None
    assert x.lookup("200.0.0.1") is None


def test_v6_lookup(tables):
    x = XtGeoIP.load(str(tables))
    assert x.lookup("2001:250::1") == "CN"
    assert x.lookup("2001:250:fff:ffff:ffff:ffff:ffff:ffff") == "CN"
    assert x.lookup("2001:251::1") is None


def test_families_do_not_leak_into_each_other(tables):
    x = XtGeoIP.load(str(tables))
    # 198.51.100.167 as an integer is a perfectly valid position in the v6
    # space; searching the wrong list would answer with a country.
    assert x.lookup("::6:1f1c:36a7") is None


def test_malformed_address_is_not_an_error(tables):
    assert XtGeoIP.load(str(tables)).lookup("not-an-ip") is None


def test_missing_directory_returns_none(tmp_path):
    assert XtGeoIP.load(str(tmp_path / "nope")) is None


def test_empty_directory_returns_none(tmp_path):
    """None, not an empty instance: a resolver that can only answer 'no' is
    indistinguishable from one that legitimately found nothing, and the caller
    should skip the code path instead."""
    assert XtGeoIP.load(str(tmp_path)) is None


def test_truncated_file_is_skipped_not_loaded(tmp_path, caplog):
    write_v4(tmp_path / "HK.iv4", [("103.28.54.0", "103.28.54.255")])
    (tmp_path / "RU.iv4").write_bytes(b"\x00" * 12)   # 12 is not a multiple of 8
    x = XtGeoIP.load(str(tmp_path))
    assert x.countries == ["HK"]
    assert x.lookup("103.28.54.1") == "HK"


def test_non_table_files_are_ignored(tmp_path):
    write_v4(tmp_path / "HK.iv4", [("103.28.54.0", "103.28.54.255")])
    (tmp_path / "README.txt").write_text("hello")
    (tmp_path / "GeoLite2-City.mmdb").write_bytes(b"x")
    x = XtGeoIP.load(str(tmp_path))
    assert x.countries == ["HK"]


def test_counts_are_reported(tables):
    x = XtGeoIP.load(str(tables))
    assert x.ranges == 4
    assert x.countries == ["CN", "HK", "ZA"]
