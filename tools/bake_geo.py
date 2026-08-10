#!/usr/bin/env python3
"""Bake Natural Earth vectors into the artifacts the globe loads at runtime.

Run once, by hand, with network access; the outputs are committed. Nothing
here executes on the kiosk or in the container.

Sources (Natural Earth via nvkelso/natural-earth-vector, public domain):
  ne_50m_land.geojson              land polygons, filled into land.png
  ne_50m_coastline.geojson         coastlines, emitted as segment pairs
  ne_10m_populated_places_simple.geojson   city points weighted by population
  ne_50m_admin_0_countries.geojson         outlines, filtered to the blocked list

Resolution note: 1:50m for the high tier. The parent design doc had 1:110m and
1:50m the wrong way round -- 1:110m is the coarser set and becomes the low-tier
fallback in chunk 2.

    pip install --user pillow
    python3 tools/bake_geo.py
"""
import json
import os
import math
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
OUT = Path(__file__).resolve().parent.parent / "netviz" / "static" / "data"
W, H = 4096, 2048

LAND_FILL = (36, 22, 74)        # deep violet, sits under the plasma arcs
LAND_EDGE = (86, 42, 140)
OCEAN = (10, 8, 26)
NIGHT_LAND = (14, 10, 34)
NIGHT_GLOW = (253, 202, 38)     # plasma #fdca26

# The countries your firewall blocks, which are the only ones that get an
# outline. Drawing every border on earth would put a second line system in
# competition with the coastlines on a display read from across a room, and
# none of it would mean anything; these do -- they are what the alarm layer is
# about.
#
# Set from the environment, because a block list describes somebody's security
# posture and does not belong in a public repo:
#
#     NETVIZ_WATCHED_COUNTRIES=RU,CN,KP python3 tools/bake_geo.py borders
#
# For the same reason the output (borders.bin, borders-index.json) is NOT
# committed -- see .gitignore. A clone with no bake simply has no watched-
# country layer; globe.js treats it as absent rather than failing.
#
# Empty is a valid configuration and produces an empty layer.
BLOCKED = {c.strip().upper()
           for c in os.environ.get("NETVIZ_WATCHED_COUNTRIES", "").split(",")
           if c.strip()}


def fetch(name: str, attempts: int = 4) -> dict:
    """Fetch one GeoJSON. Retries: raw.githubusercontent hands out multi-MB
    files and its TLS handshake times out often enough from this host that a
    single-shot fetch fails the whole bake half the time."""
    url = BASE + name
    for attempt in range(1, attempts + 1):
        print(f"fetching {url} (attempt {attempt}/{attempts})")
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == attempts:
                raise
            print(f"  retrying after {err}")
            time.sleep(3 * attempt)
    raise AssertionError("unreachable")


def to_px(lon: float, lat: float) -> tuple[float, float]:
    """Equirectangular: lon -180..180 -> 0..W, lat 90..-90 -> 0..H."""
    return ((lon + 180.0) / 360.0 * W, (90.0 - lat) / 180.0 * H)


def rings(geom: dict):
    """Yield exterior rings only. Interior rings (lakes) are ignored -- at this
    resolution and palette they are not visible, and skipping them avoids
    even-odd fill bookkeeping."""
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        yield c[0]
    elif t == "MultiPolygon":
        for poly in c:
            yield poly[0]


def lines(geom: dict):
    t, c = geom["type"], geom["coordinates"]
    if t == "LineString":
        yield c
    elif t == "MultiLineString":
        yield from c


def bake_land(land: dict) -> Image.Image:
    img = Image.new("RGB", (W, H), OCEAN)
    d = ImageDraw.Draw(img)
    for feat in land["features"]:
        for ring in rings(feat["geometry"]):
            pts = [to_px(x, y) for x, y, *_ in ring]
            if len(pts) >= 3:
                d.polygon(pts, fill=LAND_FILL, outline=LAND_EDGE)
    img.save(OUT / "land.png", optimize=True)
    print(f"wrote {OUT / 'land.png'}")
    return img


def bake_night(land: dict, cities: list[dict]) -> None:
    img = Image.new("RGB", (W, H), (4, 3, 12))
    d = ImageDraw.Draw(img)
    for feat in land["features"]:
        for ring in rings(feat["geometry"]):
            pts = [to_px(x, y) for x, y, *_ in ring]
            if len(pts) >= 3:
                d.polygon(pts, fill=NIGHT_LAND)
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for c in cities:
        x, y = to_px(c["lon"], c["lat"])
        # Small radii on purpose. At 3+14w the blobs merged into shapes that
        # matched no actual city and fought the crisp bloomed sprites; this is
        # ground glow under them, not a second set of lights.
        r = 1.2 + 4.5 * c["w"]
        gd.ellipse([x - r, y - r, x + r, y + r],
                   fill=tuple(int(v * (0.25 + 0.75 * c["w"])) for v in NIGHT_GLOW))
    glow = glow.filter(ImageFilter.GaussianBlur(3))
    # Haze only; the crisp points come from bloomed sprites in globe.js.
    img = Image.blend(img, Image.blend(img, glow, 0.9), 0.30)
    img.save(OUT / "night.png", optimize=True)
    print(f"wrote {OUT / 'night.png'}")


def bake_coastline(coast: dict) -> None:
    floats: list[float] = []
    for feat in coast["features"]:
        for line in lines(feat["geometry"]):
            for (x0, y0, *_), (x1, y1, *_) in zip(line, line[1:]):
                # Skip segments that wrap the antimeridian; drawn straight they
                # would streak across the whole globe.
                if abs(x1 - x0) > 180.0:
                    continue
                floats += [y0, x0, y1, x1]
    (OUT / "coastline.bin").write_bytes(struct.pack(f"<{len(floats)}f", *floats))
    print(f"wrote {OUT / 'coastline.bin'} ({len(floats) // 4} segments)")


def bake_borders(countries: dict) -> None:
    """Outlines of the blocked countries, as lat/lon segment pairs.

    Natural Earth's ISO_A2 is "-99" for several units (Hong Kong, Somaliland,
    Kosovo...), so ISO_A2_EH and then the admin name are checked as fallbacks --
    matching on ISO_A2 alone silently drops Hong Kong, which is one of the 21.
    """
    floats: list[float] = []
    found: set[str] = set()
    # code -> [first segment index, segment count], so the renderer can flash a
    # single country's outline when a block arc from it lands. Segments are
    # emitted grouped by country for exactly this reason -- the ranges must be
    # contiguous or a drawRange cannot address one country.
    index: dict[str, list[int]] = {}
    for feat in countries["features"]:
        props = feat["properties"]
        code = None
        for key in ("ISO_A2", "ISO_A2_EH", "iso_a2", "iso_a2_eh"):
            value = props.get(key)
            if value and value != "-99" and value in BLOCKED:
                code = value
                break
        if code is None:
            name = (props.get("ADMIN") or props.get("NAME") or "").lower()
            by_name = {"hong kong": "HK", "north korea": "KP", "south korea": None}
            code = by_name.get(name)
            if code not in BLOCKED:
                continue
        found.add(code)
        start = len(floats) // 4
        for ring in rings(feat["geometry"]):
            pts = [(x, y) for x, y, *_ in ring]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
                if abs(x1 - x0) > 180.0:      # antimeridian, see bake_coastline
                    continue
                floats += [y0, x0, y1, x1]
        # A country can appear as several features (mainland plus territories),
        # so extend an existing range rather than replacing it.
        count = len(floats) // 4 - start
        if code in index:
            index[code][1] += count
        else:
            index[code] = [start, count]
    (OUT / "borders.bin").write_bytes(struct.pack(f"<{len(floats)}f", *floats))
    (OUT / "borders-index.json").write_text(json.dumps(index, separators=(",", ":")))
    missing = sorted(BLOCKED - found)
    print(f"wrote {OUT / 'borders.bin'} ({len(floats) // 4} segments, "
          f"{len(found)}/{len(BLOCKED)} countries)")
    if missing:
        print(f"  WARNING: no geometry matched for {missing}")


def bake_border_lines(boundaries: dict) -> None:
    """Every international land border on earth, as lat/lon segment pairs.

    Source is ne_50m_admin_0_boundary_lines_land, not the country polygons:
    polygon rings would trace each shared border twice and would re-draw the
    whole coastline as a second, offset line system on top of coastline.bin.
    The boundary-lines layer carries land borders only, once each.
    """
    floats: list[float] = []
    for feat in boundaries["features"]:
        for line in lines(feat["geometry"]):
            pts = [(x, y) for x, y, *_ in line]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                if abs(x1 - x0) > 180.0:      # antimeridian, see bake_coastline
                    continue
                floats += [y0, x0, y1, x1]
    (OUT / "borders-all.bin").write_bytes(struct.pack(f"<{len(floats)}f", *floats))
    print(f"wrote {OUT / 'borders-all.bin'} ({len(floats) // 4} segments)")


ADMIN1 = {"USA", "CAN"}     # US states and Canadian provinces


def bake_admin1_lines(admin1: dict) -> None:
    """US state and Canadian province boundaries, as lat/lon segment pairs.

    ne_50m_admin_1_states_provinces_lines carries every admin-1 boundary on
    earth; drawing all of them would bury the international borders under
    Brazil, Russia and China. Property key is upper-case ADM0_A3 -- the file
    also has lower-case keys for other layers, and matching the wrong case
    silently yields zero features.
    """
    floats: list[float] = []
    kept = 0
    for feat in admin1["features"]:
        if feat["properties"].get("ADM0_A3") not in ADMIN1:
            continue
        kept += 1
        for line in lines(feat["geometry"]):
            pts = [(x, y) for x, y, *_ in line]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                if abs(x1 - x0) > 180.0:      # antimeridian, see bake_coastline
                    continue
                floats += [y0, x0, y1, x1]
    (OUT / "admin1.bin").write_bytes(struct.pack(f"<{len(floats)}f", *floats))
    print(f"wrote {OUT / 'admin1.bin'} ({len(floats) // 4} segments, "
          f"{kept} features)")
    if not kept:
        print("  WARNING: nothing matched -- check the ADM0_A3 key case")


def bake_cities(places: dict) -> list[dict]:
    rows = []
    for feat in places["features"]:
        pop = feat["properties"].get("pop_max") or 0
        if pop < 200_000:
            continue
        lon, lat = feat["geometry"]["coordinates"][:2]
        rows.append({"lat": round(lat, 4), "lon": round(lon, 4),
                     "w": round(min(1.0, math.log10(pop) / math.log10(2.5e7)), 4)})
    rows.sort(key=lambda r: -r["w"])
    rows = rows[:1200]
    (OUT / "cities.json").write_text(json.dumps(rows, separators=(",", ":")))
    print(f"wrote {OUT / 'cities.json'} ({len(rows)} cities)")
    return rows


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # `bake_geo.py borders` re-bakes only the two line files. The land/night
    # textures take the longest fetches and never change; there is no reason to
    # risk a flaky raw.githubusercontent handshake on them to retouch borders.
    if len(sys.argv) > 1 and sys.argv[1] == "borders":
        bake_borders(fetch("ne_50m_admin_0_countries.geojson"))
        bake_border_lines(fetch("ne_50m_admin_0_boundary_lines_land.geojson"))
        bake_admin1_lines(fetch("ne_50m_admin_1_states_provinces_lines.geojson"))
        return
    land = fetch("ne_50m_land.geojson")
    coast = fetch("ne_50m_coastline.geojson")
    places = fetch("ne_10m_populated_places_simple.geojson")
    countries = fetch("ne_50m_admin_0_countries.geojson")
    bake_land(land)
    cities = bake_cities(places)
    bake_night(land, cities)
    bake_coastline(coast)
    bake_borders(countries)
    bake_border_lines(fetch("ne_50m_admin_0_boundary_lines_land.geojson"))
    bake_admin1_lines(fetch("ne_50m_admin_1_states_provinces_lines.geojson"))


if __name__ == "__main__":
    main()
