#!/usr/bin/env python3
"""Bake the netviz favicon: globe disc + plasma arcs converging on home.

Outputs into netviz/static/:
    icon.svg         full detail, what modern browsers use
    icon-512.png     same mark, for anything that wants a raster
    favicon-32.png   simplified: no grid, 2 arcs, fatter strokes
    favicon-16.png   same simplification, sized down

The small sizes are deliberately a *different drawing*, not a downscale --
the meridian grid and three arcs turn to grey mush below ~48px.

Colors are the plasma ramp from netviz/static/js/palette.js. Keep them in
sync by hand; there are only ten stops and they never change.

Run:  python3 tools/make_icon.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --- palette -----------------------------------------------------------------

PLASMA = [
    "#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786",
    "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921",
]

DISC_EDGE = (13, 8, 135)      # #0d0887, the unlit limb
DISC_CORE = (86, 26, 168)     # lifted violet at the lit centre
GRID = (156, 23, 158)         # #9c179e
HALO = (114, 1, 168)          # #7201a8


def _hex(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


_STOPS = [_hex(h) for h in PLASMA]


def plasma_at(t: float) -> tuple[int, int, int]:
    """Sample the ramp. 0 is deep indigo, 1 is pale yellow."""
    x = min(1.0, max(0.0, t)) * (len(_STOPS) - 1)
    i = int(math.floor(x))
    j = min(len(_STOPS) - 1, i + 1)
    f = x - i
    a, b = _STOPS[i], _STOPS[j]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def _mix(a, b, f):
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


# --- geometry ----------------------------------------------------------------
# All in units of the disc radius R, origin at the disc centre, +y down.
# Endpoints sit inside the limb so the arc roots read as "on the sphere".

HOME = (-0.04, 0.06)
ARCS_FULL = [(-0.78, -0.44), (0.84, -0.12), (0.30, 0.80)]
ARCS_SMALL = [(-0.78, -0.40), (0.72, 0.46)]
ARC_LIFT = 0.34


def _bezier(p0, p1, p2, n):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ))
    return out


def _control(start, home, lift):
    """Bow the curve sideways, not outward.

    Pushing the control point radially away from the disc centre barely bends
    an arc whose far end is already near the centre -- the first cut rendered
    three straight spokes and read as a clock face. Offsetting perpendicular
    to the chord, away from the centre, gives an actual arc.
    """
    mx = (start[0] + home[0]) / 2
    my = (start[1] + home[1]) / 2
    dx, dy = home[0] - start[0], home[1] - start[1]
    span = math.hypot(dx, dy) or 1e-6
    px, py = -dy / span, dx / span
    if px * mx + py * my < 0:          # keep the bulge on the outward side
        px, py = -px, -py
    return (mx + px * lift * span, my + py * lift * span)


def _arc_points(start, home, lift, n=160):
    """Quadratic bezier bowed away from the disc centre.

    The renderer uses slerped great circles because beziers sag below the
    sphere past ~130 degrees of separation. Here nothing spans more than a
    hemisphere and the curve is decorative, so a bezier is fine.
    """
    return _bezier(start, _control(start, home, lift), home, n)


# --- raster ------------------------------------------------------------------

SS = 8  # supersample factor


def _disc(size: int, r: float) -> Image.Image:
    """Sphere shading, drawn as concentric circles from the limb inward."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2
    steps = 220
    for i in range(steps):
        f = i / (steps - 1)              # 0 at limb, 1 at centre
        rr = r * (1 - f)
        col = _mix(DISC_EDGE, DISC_CORE, f ** 1.6)
        d.ellipse([c - rr, c - rr, c + rr, c + rr], fill=col + (255,))
    return img


def _mask(size: int, r: float) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    c = size / 2
    ImageDraw.Draw(m).ellipse([c - r, c - r, c + r, c + r], fill=255)
    return m


def _grid(size: int, r: float) -> Image.Image:
    """Meridians and parallels, clipped to the disc."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2
    w = max(1, round(size * 0.004))
    for k in (0.34, 0.68, 1.0):
        rx = r * k
        d.ellipse([c - rx, c - r, c + rx, c + r], outline=GRID + (150,), width=w)
    d.line([c, c - r, c, c + r], fill=GRID + (150,), width=w)
    for phi in (-52, -26, 0, 26, 52):
        a = math.radians(phi)
        rx, y = r * math.cos(a), r * math.sin(a)
        ry = max(w, rx * 0.30)
        d.ellipse([c - rx, c + y - ry, c + rx, c + y + ry],
                  outline=GRID + (150,), width=w)
    img.putalpha(Image.composite(img.getchannel("A"),
                                 Image.new("L", (size, size), 0),
                                 _mask(size, r)))
    return img


def _stroke(img, pts, width, color_at, alpha):
    """Polyline with a per-segment color and round joints."""
    d = ImageDraw.Draw(img)
    n = len(pts) - 1
    for i in range(n):
        col = color_at(i / n) + (alpha,)
        d.line([pts[i], pts[i + 1]], fill=col, width=width)
        rr = width / 2
        x, y = pts[i + 1]
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)


def _arcs(size: int, r: float, starts, lift: float, thick: float,
          dot_scale: float = 1.7) -> Image.Image:
    """Arcs plus their glow, on their own layer so the blur stays local."""
    c = size / 2
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    core = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    w = max(2, round(size * thick))

    def to_px(p):
        return (c + p[0] * r, c + p[1] * r)

    for s in starts:
        pts = [to_px(p) for p in _arc_points(s, HOME, lift)]
        col = lambda t: plasma_at(0.42 + 0.48 * t)  # noqa: E731
        _stroke(glow, pts, w * 3, col, 90)
        _stroke(core, pts, w, col, 255)

    # home dot, and its own halo
    hx, hy = to_px(HOME)
    dot = max(2, round(size * thick * dot_scale))
    ImageDraw.Draw(glow).ellipse([hx - dot * 1.9, hy - dot * 1.9,
                                  hx + dot * 1.9, hy + dot * 1.9],
                                 fill=plasma_at(0.95) + (95,))
    ImageDraw.Draw(core).ellipse([hx - dot, hy - dot, hx + dot, hy + dot],
                                 fill=plasma_at(0.99) + (255,))

    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.012))
    glow.alpha_composite(core)
    return glow


def render(size: int, detailed: bool) -> Image.Image:
    w = size * SS
    r = w * (0.365 if detailed else 0.375)
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    # atmosphere: a soft ring just outside the limb
    halo = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    c = w / 2
    hr = r * 1.10
    ImageDraw.Draw(halo).ellipse([c - hr, c - hr, c + hr, c + hr],
                                 fill=HALO + (110,))
    halo = halo.filter(ImageFilter.GaussianBlur(w * 0.02))
    img.alpha_composite(halo)

    img.alpha_composite(_disc(w, r))
    if detailed:
        img.alpha_composite(_grid(w, r))
        img.alpha_composite(_arcs(w, r, ARCS_FULL, ARC_LIFT, 0.021))
    else:
        img.alpha_composite(_arcs(w, r, ARCS_SMALL, ARC_LIFT, 0.038, 1.35))

    return img.resize((size, size), Image.LANCZOS)


# --- svg ---------------------------------------------------------------------

def svg() -> str:
    """Same mark as the detailed raster, resolution independent."""
    r = 36.5
    c = 50.0

    def px(p):
        return (c + p[0] * r, c + p[1] * r)

    paths = []
    for s in ARCS_FULL:
        (x0, y0) = px(s)
        (cx, cy) = px(_control(s, HOME, ARC_LIFT))
        (x2, y2) = px(HOME)
        paths.append(f'M {x0:.2f} {y0:.2f} Q {cx:.2f} {cy:.2f} {x2:.2f} {y2:.2f}')

    arcs = "\n".join(
        f'    <path d="{p}" stroke="url(#arc)" stroke-width="1.6" fill="none" '
        f'stroke-linecap="round" filter="url(#glow)" opacity="0.55"/>\n'
        f'    <path d="{p}" stroke="url(#arc)" stroke-width="1.6" fill="none" '
        f'stroke-linecap="round"/>'
        for p in paths
    )

    mer = "\n".join(
        f'    <ellipse cx="{c}" cy="{c}" rx="{r * k:.2f}" ry="{r}"/>'
        for k in (0.34, 0.68, 1.0)
    )
    par = []
    for phi in (-52, -26, 0, 26, 52):
        a = math.radians(phi)
        rx, y = r * math.cos(a), r * math.sin(a)
        par.append(f'    <ellipse cx="{c}" cy="{c + y:.2f}" rx="{rx:.2f}" '
                   f'ry="{max(0.35, rx * 0.30):.2f}"/>')
    hx, hy = px(HOME)

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <title>netviz</title>
  <defs>
    <radialGradient id="disc" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#561aa8"/>
      <stop offset="70%" stop-color="#2a0a95"/>
      <stop offset="100%" stop-color="#0d0887"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="80%" stop-color="#7201a8" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#7201a8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="arc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7201a8"/>
      <stop offset="50%" stop-color="#d8576b"/>
      <stop offset="100%" stop-color="#fdca26"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.6"/>
    </filter>
    <clipPath id="disc-clip"><circle cx="{c}" cy="{c}" r="{r}"/></clipPath>
  </defs>
  <circle cx="{c}" cy="{c}" r="{r * 1.16:.2f}" fill="url(#halo)"/>
  <circle cx="{c}" cy="{c}" r="{r}" fill="url(#disc)"/>
  <g clip-path="url(#disc-clip)" fill="none" stroke="#9c179e"
     stroke-width="0.45" opacity="0.6">
{mer}
    <line x1="{c}" y1="{c - r}" x2="{c}" y2="{c + r}"/>
{chr(10).join(par)}
  </g>
{arcs}
  <circle cx="{hx:.2f}" cy="{hy:.2f}" r="4.2" fill="#f0f921" opacity="0.35"
          filter="url(#glow)"/>
  <circle cx="{hx:.2f}" cy="{hy:.2f}" r="1.9" fill="#f0f921"/>
</svg>
'''


# --- repository banner -------------------------------------------------------

WORDMARK = (236, 232, 255)     # near white, not pure -- pure white on #0b0916
                               # rings against the plasma palette
TAGLINE = (141, 125, 184)      # muted violet, clearly secondary to the wordmark
BANNER_BG = (11, 9, 22)        # #0b0916, the display's own background
NAME_TEXT = "netviz"
TAG_TEXT = "live network traffic, drawn on a globe"

# Bold, wide-coverage, and present on every distribution this is likely to be
# run on. Checked in order; a missing font is a hard failure rather than a
# silent fallback to Pillow's bitmap default, which looks like a ransom note at
# 200px.
FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
)


def _font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit(f"no usable bold font found; looked for {FONTS}")


def banner(width: int = 2000, height: int = 560) -> Image.Image:
    """Wide mark + wordmark for the top of the README.

    Rendered at roughly twice its display width so it stays sharp on a HiDPI
    screen -- GitHub serves the file at whatever width the markup asks for, so
    the extra pixels cost only bytes.

    The mark and the two lines of text are measured and centred as one group.
    Laying them out from a fixed left margin instead leaves the whole lockup
    sitting left of centre with a band of dead background beside it, which is
    exactly what the first cut did.
    """
    img = Image.new("RGB", (width, height), BANNER_BG)
    d = ImageDraw.Draw(img)

    mark_px = int(height * 0.80)
    name = _font(int(height * 0.40))
    tag = _font(int(height * 0.105))

    n_box = d.textbbox((0, 0), NAME_TEXT, font=name)
    t_box = d.textbbox((0, 0), TAG_TEXT, font=tag)
    n_w, n_h = n_box[2] - n_box[0], n_box[3] - n_box[1]
    t_w, t_h = t_box[2] - t_box[0], t_box[3] - t_box[1]

    gap_mark = int(height * 0.10)          # mark to text
    gap_line = int(height * 0.075)         # wordmark to tagline
    group_w = mark_px + gap_mark + max(n_w, t_w)
    x0 = (width - group_w) // 2

    mark = render(mark_px, True)
    img.paste(mark, (x0, (height - mark_px) // 2), mark)

    x = x0 + mark_px + gap_mark
    y = (height - (n_h + gap_line + t_h)) // 2
    d.text((x - n_box[0], y - n_box[1]), NAME_TEXT, font=name, fill=WORDMARK)
    d.text((x - t_box[0], y + n_h + gap_line - t_box[1]), TAG_TEXT,
           font=tag, fill=TAGLINE)

    return img


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "netviz" / "static"
    (out / "icon.svg").write_text(svg())
    render(512, True).save(out / "icon-512.png")
    render(32, False).save(out / "favicon-32.png")
    render(16, False).save(out / "favicon-16.png")
    for f in ("icon.svg", "icon-512.png", "favicon-32.png", "favicon-16.png"):
        print(f"wrote {out / f}")

    assets = Path(__file__).resolve().parent.parent / "assets"
    assets.mkdir(exist_ok=True)
    banner().save(assets / "banner.png")
    print(f"wrote {assets / 'banner.png'}")


if __name__ == "__main__":
    main()
