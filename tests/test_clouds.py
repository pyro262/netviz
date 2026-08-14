import io
import struct
import time
import zlib

import pytest

from netviz import clouds


# --- which granule to ask for -------------------------------------------------

def test_hour_prefixes_walk_backwards_from_now():
    # 2026-08-14T20:34:00Z
    now = 1786739640.0
    got = clouds.hour_prefixes(now, back=3)
    assert got == [
        "GMGSI_LW/2026/08/14/20/",
        "GMGSI_LW/2026/08/14/19/",
        "GMGSI_LW/2026/08/14/18/",
    ]


def test_hour_prefixes_cross_a_day_boundary():
    # 2026-08-14T00:20:00Z -- the previous hours are yesterday's, and getting
    # this wrong means a blank globe for an hour every night.
    now = 1786666800.0
    got = clouds.hour_prefixes(now, back=3)
    assert got == [
        "GMGSI_LW/2026/08/14/00/",
        "GMGSI_LW/2026/08/13/23/",
        "GMGSI_LW/2026/08/13/22/",
    ]


LISTING = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>noaa-gmgsi-pds</Name>
<Contents><Key>GMGSI_LW/2026/08/14/20/GLOBCOMPLIR_v3r0_blend_s202608142000000_e1_c1.nc</Key></Contents>
<Contents><Key>GMGSI_LW/2026/08/14/20/GLOBCOMPLIR_v3r0_blend_s202608142010000_e2_c2.nc</Key></Contents>
</ListBucketResult>"""


def test_parse_listing_reads_every_key():
    assert clouds.parse_listing(LISTING) == [
        "GMGSI_LW/2026/08/14/20/GLOBCOMPLIR_v3r0_blend_s202608142000000_e1_c1.nc",
        "GMGSI_LW/2026/08/14/20/GLOBCOMPLIR_v3r0_blend_s202608142010000_e2_c2.nc",
    ]


def test_parse_listing_survives_junk():
    # An S3 error, an HTML captive portal, an empty body: all "no keys", never
    # an exception. The globe keeps drawing when the bucket is unreachable.
    assert clouds.parse_listing("") == []
    assert clouds.parse_listing("<html>nope</html>") == []
    assert clouds.parse_listing("<ListBucketResult></ListBucketResult>") == []


def test_newest_key_is_the_last_start_time_not_the_last_string():
    # Keys sort by name and the start stamp is inside the name, so lexical
    # order happens to agree -- but only while the prefix is constant. Pick on
    # the parsed stamp so a version bump (v3r0 -> v4r0) cannot silently
    # reorder them.
    keys = [
        "x/GLOBCOMPLIR_v4r0_blend_s202608142000000_e1_c1.nc",
        "x/GLOBCOMPLIR_v3r0_blend_s202608142010000_e2_c2.nc",
    ]
    assert clouds.newest_key(keys).endswith("s202608142010000_e2_c2.nc")


def test_newest_key_ignores_names_it_cannot_date():
    assert clouds.newest_key(["x/README.txt"]) is None
    assert clouds.newest_key([]) is None


def test_granule_time_reads_the_start_stamp():
    key = "x/GLOBCOMPLIR_v3r0_blend_s202608142000000_e202608142009599_c202608142034439.nc"
    assert clouds.granule_time(key) == 1786737600.0     # 2026-08-14T20:00:00Z


# --- the poll cadence ---------------------------------------------------------

def test_poll_fires_after_the_hour_has_been_published():
    # GMGSI's 20:00Z granule was written at 20:34Z, measured. Polling on the
    # hour asks for a file that does not exist yet, so the offset is what makes
    # the request worth making.
    period, offset = 3600.0, 45 * 60.0
    at_2045 = 1786480_000.0 - (1786480_000.0 % 3600.0) + offset
    assert clouds.next_poll_delay(at_2045 + 1.0, period, offset) == pytest.approx(3599.0)
    assert clouds.next_poll_delay(at_2045 - 600.0, period, offset) == pytest.approx(600.0)


def test_poll_delay_is_never_zero():
    # A zero delay spins the poller into a hot loop against someone else's
    # free bucket. Same guard as aurora.next_poll_delay.
    period, offset = 3600.0, 45 * 60.0
    boundary = 1786480_000.0 - (1786480_000.0 % 3600.0) + offset
    for t in (boundary, boundary - 0.5, boundary + 0.5):
        assert clouds.next_poll_delay(t, period, offset) > 0.0


# --- the PNG the renderer gets ------------------------------------------------

def decode_png(data):
    """Width, height, bit depth and colour type from a PNG's IHDR."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    length, tag = struct.unpack(">I4s", data[8:16])
    assert tag == b"IHDR"
    w, h, depth, color = struct.unpack(">IIBB", data[16:26])
    return w, h, depth, color


def png_pixels(data):
    """Every pixel of an 8-bit greyscale PNG, row-major. Undoes the filters."""
    w, h, depth, color = decode_png(data)
    assert (depth, color) == (8, 0)
    idat = b""
    i = 8
    while i < len(data):
        length, tag = struct.unpack(">I4s", data[i:i + 8])
        if tag == b"IDAT":
            idat += data[i + 8:i + 8 + length]
        i += 12 + length
    raw = zlib.decompress(idat)
    out, prev = [], bytearray(w)
    for y in range(h):
        start = y * (w + 1)
        ftype = raw[start]
        assert ftype == 0, "the writer emits no filtering"
        row = bytearray(raw[start + 1:start + 1 + w])
        out.append(row)
        prev = row
    return out


def test_write_png_round_trips_through_a_decoder():
    import numpy as np
    a = np.array([[0, 128, 255], [7, 8, 9]], dtype=np.uint8)
    data = clouds.write_png(a)
    assert decode_png(data) == (3, 2, 8, 0)
    assert [list(r) for r in png_pixels(data)] == [[0, 128, 255], [7, 8, 9]]


def test_write_png_is_readable_by_a_real_decoder():
    Image = pytest.importorskip("PIL.Image")
    import numpy as np
    a = (np.arange(64, dtype=np.uint8).reshape(8, 8) * 4).astype("uint8")
    im = Image.open(io.BytesIO(clouds.write_png(a)))
    assert im.size == (8, 8) and im.mode == "L"
    assert list(im.getdata())[:4] == [0, 4, 8, 12]


def test_downsample_averages_blocks_and_drops_the_odd_column():
    import numpy as np
    # 4x3 -> 2x1 at factor 2: the odd row is dropped rather than smeared, and
    # each output pixel is the mean of its 2x2 block.
    a = np.array([[0, 10, 100, 200],
                  [20, 30, 100, 200],
                  [255, 255, 255, 255]], dtype=np.uint8)
    out = clouds.downsample(a, 2)
    assert out.shape == (1, 2)
    assert out.tolist() == [[15, 150]]


@pytest.fixture
def granule(tmp_path):
    """A miniature GMGSI granule: the same shapes and names, 8x4 pixels."""
    h5py = pytest.importorskip("h5py")
    import numpy as np
    path = tmp_path / "mini.nc"
    with h5py.File(path, "w") as f:
        data = np.zeros((1, 4, 8), dtype="float32")
        data[0, 0, :] = 200.0            # a bright cloud band
        data[0, 1, :] = 20.0             # clear
        data[0, 2, :] = 255.0            # the bad-data block
        data[0, 3, :] = 60.0
        dqf = np.zeros((1, 4, 8), dtype="int8")
        dqf[0, 2, :] = 1                 # ...flagged as bad
        f.create_dataset("data", data=data)
        f.create_dataset("dqf", data=dqf)
        f.attrs["time_coverage_start"] = "2026-08-14T20:00:00Z"
    return path


def test_granule_to_png_masks_the_flagged_rows(granule):
    pytest.importorskip("h5py")
    png, valid = clouds.granule_to_png(str(granule), factor=1)
    rows = png_pixels(png)
    assert len(rows) == 4 and len(rows[0]) == 8
    assert rows[0][0] == 200          # cloud kept
    assert rows[1][0] == 20           # clear kept
    # THE BAD BLOCK BECOMES CLEAR SKY, NOT WHITE. Left alone it renders as a
    # solid opaque slab across the globe -- the single most visible artifact in
    # the raw granule, and the reason dqf is read at all.
    assert rows[2][0] == 0
    assert rows[3][0] == 60
    assert valid == 1786737600.0


def test_granule_to_png_refuses_a_file_that_is_not_one(tmp_path):
    bad = tmp_path / "not.nc"
    bad.write_bytes(b"this is not HDF5")
    assert clouds.granule_to_png(str(bad)) is None


# --- the cache the endpoint serves -------------------------------------------

def test_cache_starts_empty_and_serves_nothing(tmp_path):
    c = clouds.CloudCache(str(tmp_path / "clouds.png"))
    assert c.read() is None
    st = c.state(1000.0)
    assert st["valid"] is None and st["stale"] is True


def test_cache_write_is_atomic_and_readable(tmp_path):
    path = tmp_path / "clouds.png"
    c = clouds.CloudCache(str(path))
    c.update(b"\x89PNG-pretend", 900.0, now=1000.0)
    assert c.read() == b"\x89PNG-pretend"
    # No tmp file left behind: a half-written texture served to the wall is a
    # broken image, and the kiosk caches by ETag.
    assert [p.name for p in tmp_path.iterdir()] == ["clouds.png"]
    st = c.state(1000.0)
    assert st["valid"] == 900.0 and st["age"] == 100.0 and st["stale"] is False


def test_cache_goes_stale_and_says_so(tmp_path):
    c = clouds.CloudCache(str(tmp_path / "clouds.png"), ttl=3 * 3600.0)
    c.update(b"x", 0.0, now=0.0)
    assert c.state(3 * 3600.0 - 1)["stale"] is False
    # >= not >, the same boundary rule KpCache uses.
    assert c.state(3 * 3600.0)["stale"] is True


def test_cache_survives_a_failed_refresh(tmp_path):
    # None means "we could not reach the bucket", which must keep the last real
    # clouds on the globe and let them age -- not blank the layer.
    c = clouds.CloudCache(str(tmp_path / "clouds.png"))
    c.update(b"real", 100.0, now=100.0)
    c.update(None, None, now=200.0)
    assert c.read() == b"real"
    assert c.state(200.0)["valid"] == 100.0


def test_cache_reloads_an_existing_file_across_a_restart(tmp_path):
    # /state survives a restart, and re-downloading 7MB because the process
    # bounced is exactly the waste the IPFIX template cache exists to avoid.
    path = tmp_path / "clouds.png"
    first = clouds.CloudCache(str(path))
    first.update(b"kept", 500.0, now=500.0)
    second = clouds.CloudCache(str(path))
    assert second.read() == b"kept"
    # The valid time comes back from the file's mtime, so the age is real
    # rather than "as old as this process".
    assert second.state(500.0)["valid"] == pytest.approx(500.0, abs=2.0)


def test_cache_tolerates_an_unwritable_state_directory(tmp_path):
    # A read-only /state must cost the clouds, never the collector: same rule
    # as the IPFIX template file.
    c = clouds.CloudCache(str(tmp_path / "nope" / "clouds.png"))
    c.update(b"x", 1.0, now=1.0)
    assert c.read() is None
    assert c.state(1.0)["stale"] is True
