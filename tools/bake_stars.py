#!/usr/bin/env python3
"""Bake the HYG star catalogue into the file the globe loads at runtime.

Run by hand with network access; the output is committed. Nothing here runs on
the kiosk. Source: astronexus/HYG-Database (CC BY-SA 4.0), which merges
Hipparcos, Yale Bright Star and Gliese.

    python3 tools/bake_stars.py            # mag <= 6.5, ~9000 stars
    python3 tools/bake_stars.py --limit 5.5

Output: netviz/static/data/stars.bin -- float32 quads, [ra_deg, dec_deg, mag, ci],
little endian. Equatorial coordinates, epoch J2000; stars.js turns them into
scene directions and rotates them by Greenwich sidereal time.

Magnitude 6.5 is the naked-eye limit under a dark sky, which is the right cut
for a display meant to look like the sky rather than like a survey.
"""
import argparse
import csv
import io
import struct
import sys
import urllib.request
from pathlib import Path

URL = ("https://raw.githubusercontent.com/astronexus/HYG-Database/main/"
       "hyg/CURRENT/hygdata_v41.csv")
OUT = Path(__file__).resolve().parent.parent / "netviz" / "static" / "data"


def fetch(url: str, attempts: int = 4) -> str:
    for attempt in range(1, attempts + 1):
        print(f"fetching {url} (attempt {attempt}/{attempts})")
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as err:                      # noqa: BLE001 -- retry anything
            if attempt == attempts:
                raise
            print(f"  retrying after {err}")
    raise AssertionError("unreachable")


def bake(text: str, limit: float) -> int:
    rows = csv.DictReader(io.StringIO(text))
    out = bytearray()
    kept = 0
    brightest = None
    for row in rows:
        try:
            mag = float(row["mag"])
        except (TypeError, ValueError):
            continue
        if mag > limit:
            continue
        # id 0 is Sol itself, sitting at distance 0 -- it has no place in a sky.
        if row.get("id") == "0":
            continue
        try:
            ra_hours = float(row["ra"])               # catalogue stores HOURS
            dec = float(row["dec"])
        except (TypeError, ValueError):
            continue
        try:
            ci = float(row["ci"])                     # B-V color index
        except (TypeError, ValueError):
            ci = 0.0                                  # treat unknown as sun-like
        out += struct.pack("<ffff", ra_hours * 15.0, dec, mag, ci)
        kept += 1
        if brightest is None or mag < brightest[0]:
            brightest = (mag, row.get("proper") or row.get("bf") or "?")

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "stars.bin").write_bytes(bytes(out))
    print(f"wrote {OUT / 'stars.bin'} ({kept} stars to mag {limit}, "
          f"{len(out) / 1024:.0f} KiB)")
    if brightest:
        print(f"  brightest: {brightest[1]} at mag {brightest[0]}")
    return kept


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=float, default=6.5,
                    help="faintest magnitude to keep (6.5 = naked-eye limit)")
    ap.add_argument("--csv", type=Path, default=None,
                    help="use a local copy instead of fetching")
    args = ap.parse_args()

    text = args.csv.read_text() if args.csv else fetch(URL)
    if bake(text, args.limit) < 1000:
        print("ERROR: implausibly few stars -- check the catalogue columns",
              file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
