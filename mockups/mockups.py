#!/usr/bin/env python3
"""Kiosk globe style mockups - A: 3D globe, B: 2D flat, C: hybrid.
Continents are coarse hand-digitised blobs: layout/style mockup, not a real basemap."""
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, FancyBboxPatch
from matplotlib.cm import plasma

BG = "#0b0a14"
PANEL = "#151327"
LAND = "#2a2545"
LANDE = "#4c4173"
GRID = "#241f3d"
TXT = "#c9c3e6"
DIM = "#6f689a"

LAND_POLYS = [
    [(-168,65),(-140,70),(-95,72),(-60,60),(-55,47),(-75,35),(-82,25),(-97,18),
     (-105,20),(-115,30),(-125,40),(-140,60)],
    [(-80,10),(-60,10),(-35,-5),(-35,-22),(-55,-35),(-70,-55),(-75,-45),(-82,-5)],
    [(-17,15),(0,35),(12,37),(32,32),(43,12),(51,11),(40,-5),(40,-25),(20,-35),
     (12,-18),(8,4),(-8,5)],
    [(-10,36),(-9,44),(0,50),(5,58),(20,70),(40,68),(60,66),(60,50),(40,45),
     (28,40),(20,38),(10,44),(0,43)],
    [(60,66),(100,75),(140,72),(160,68),(140,50),(135,35),(120,22),(105,10),
     (95,15),(80,8),(70,22),(60,25),(45,40),(50,55)],
    [(114,-22),(130,-12),(142,-11),(150,-25),(147,-38),(135,-35),(120,-34)],
]

# (lat, lon, label) -- blocked-country sources + local endpoint
SRC = [(55.7,37.6,"RU"),(39.9,116.4,"CN"),(35.7,51.4,"IR"),(28.6,77.2,"IN"),
       (50.4,30.5,"UA"),(-6.2,106.8,"ID"),(9.1,7.5,"NG"),(24.7,46.7,"SA"),
       (44.4,26.1,"RO"),(-26.2,28.0,"ZA"),(21.0,105.8,"VN"),(48.0,66.9,"KZ")]
HOME = (30.3, -97.7)   # local site


def bez(p0, p1, lift=0.22, n=90):
    """Quadratic bezier between two 2-D points, bowed perpendicular."""
    p0, p1 = np.array(p0, float), np.array(p1, float)
    mid = (p0 + p1) / 2
    d = p1 - p0
    perp = np.array([-d[1], d[0]])
    nrm = np.linalg.norm(perp)
    if nrm:
        perp = perp / nrm * np.linalg.norm(d) * lift
    c = mid + perp
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t ** 2 * p1


def grad_line(ax, pts, cmap_lo=0.15, cmap_hi=0.95, lw=1.6, alpha=1.0, z=5):
    """Draw a polyline shaded along the plasma ramp."""
    for i in range(len(pts) - 1):
        f = i / (len(pts) - 2)
        ax.plot(pts[i:i+2, 0], pts[i:i+2, 1],
                color=plasma(cmap_lo + (cmap_hi - cmap_lo) * f),
                lw=lw, alpha=alpha, solid_capstyle="round", zorder=z)


def ortho(lat, lon, lat0, lon0, r=1.0):
    """Orthographic projection. Returns (x, y, visible)."""
    la, lo = np.radians(lat), np.radians(lon)
    la0, lo0 = np.radians(lat0), np.radians(lon0)
    cosc = np.sin(la0) * np.sin(la) + np.cos(la0) * np.cos(la) * np.cos(lo - lo0)
    x = r * np.cos(la) * np.sin(lo - lo0)
    y = r * (np.cos(la0) * np.sin(la) - np.sin(la0) * np.cos(la) * np.cos(lo - lo0))
    return x, y, cosc >= 0


def panel(ax, x, y, w, h, title, lines, fs=8.5):
    """Rounded panel. Line spacing is derived from h so text can never overflow."""
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.012",
                                fc=PANEL, ec="#2e2850", lw=1, zorder=10,
                                transform=ax.transAxes))
    pad = .020
    top = y + h - pad
    ax.text(x + pad, top, title, transform=ax.transAxes, color=DIM, va="top",
            fontsize=7.5, weight="bold", zorder=11, family="monospace")
    body_top = top - .045
    avail = body_top - (y + pad)
    step = avail / max(len(lines), 1)
    for i, (t, c) in enumerate(lines):
        ax.text(x + pad, body_top - i * step, t, transform=ax.transAxes, va="top",
                color=c, fontsize=fs, zorder=11, family="monospace")


def chrome(fig, ax, title, sub):
    ax.text(.012, .965, title, transform=ax.transAxes, color=TXT, fontsize=13,
            weight="bold", family="monospace", zorder=12)
    ax.text(.012, .935, sub, transform=ax.transAxes, color=DIM, fontsize=8.5,
            family="monospace", zorder=12)


def draw_land_flat(ax, xoff=0.0, scale=1.0, alpha=1.0):
    for poly in LAND_POLYS:
        p = np.array(poly, float)
        ax.add_patch(Polygon(np.c_[p[:, 0] * scale + xoff, p[:, 1] * scale],
                             closed=True, fc=LAND, ec=LANDE, lw=.8,
                             alpha=alpha, zorder=2))


def flat_axes(ax):
    ax.set_xlim(-180, 180); ax.set_ylim(-62, 84)
    for v in range(-180, 181, 30):
        ax.plot([v, v], [-62, 84], color=GRID, lw=.5, zorder=1)
    for v in range(-60, 81, 30):
        ax.plot([-180, 180], [v, v], color=GRID, lw=.5, zorder=1)
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_facecolor(BG)


STATS = [("BLOCK  1,284 / 24h", "#f0f921"),
         ("TOP    RU  412", TXT),
         ("       CN  361", TXT),
         ("       IR  188", TXT)]
FLOW = [("FLOWS  8.4k/min", "#f89540"),
        ("WAN1   eth8  UP", "#b02a8f"),
        ("IPFIX  2055  OK", TXT),
        ("LAG    4.1s", DIM)]


def globe(ax, lat0=18, lon0=10, cx=0.0, cy=0.0, R=1.0, arc_lw=1.6, labels=True):
    th = np.linspace(0, 2 * np.pi, 300)
    ax.add_patch(plt.Circle((cx, cy), R, fc="#111024", ec="#3a3260", lw=1.4, zorder=1))
    for lo in range(-180, 181, 30):
        la = np.linspace(-90, 90, 120)
        x, y, v = ortho(la, np.full_like(la, lo), lat0, lon0, R)
        x, y = np.where(v, x + cx, np.nan), np.where(v, y + cy, np.nan)
        ax.plot(x, y, color=GRID, lw=.5, zorder=2)
    for la_ in range(-60, 61, 30):
        lo = np.linspace(-180, 180, 240)
        x, y, v = ortho(np.full_like(lo, la_), lo, lat0, lon0, R)
        ax.plot(np.where(v, x + cx, np.nan), np.where(v, y + cy, np.nan),
                color=GRID, lw=.5, zorder=2)
    for poly in LAND_POLYS:
        p = np.array(poly, float)
        x, y, v = ortho(p[:, 1], p[:, 0], lat0, lon0, R)
        if v.sum() < 3:
            continue
        ax.add_patch(Polygon(np.c_[x[v] + cx, y[v] + cy], closed=True, fc=LAND,
                             ec=LANDE, lw=.8, zorder=3))
    hx, hy, _ = ortho(HOME[0], HOME[1], lat0, lon0, R)
    for lat, lon, lab in SRC:
        sx, sy, vis = ortho(lat, lon, lat0, lon0, R)
        if not vis:
            continue
        pts = bez((sx + cx, sy + cy), (hx + cx, hy + cy), lift=0.20)
        grad_line(ax, pts, lw=arc_lw, z=6)
        ax.scatter([sx + cx], [sy + cy], s=16, color="#f0f921", zorder=7)
        if labels:
            ax.text(sx + cx, sy + cy + .045 * R, lab, color="#f0f921", fontsize=7,
                    ha="center", family="monospace", zorder=8)
    ax.scatter([hx + cx], [hy + cy], s=70, marker="*", color="#f7e225", zorder=9)
    ax.plot(cx + R * np.cos(th), cy + R * np.sin(th), color="#6a4fa0", lw=1, zorder=4)


def fig_base(w=16, h=9):
    fig = plt.figure(figsize=(w, h), dpi=100, facecolor=BG)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor(BG)
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    return fig, ax


OUT = os.environ.get("MOCKUP_OUT", os.path.dirname(os.path.abspath(__file__)))

# ---------- A: 3D rotating globe ----------
fig, ax = fig_base()
ax.set_xlim(0, 16); ax.set_ylim(0, 9)
gax = fig.add_axes([0.02, 0.03, 0.68, 0.86]); gax.set_facecolor(BG)
gax.set_xlim(-1.15, 1.15); gax.set_ylim(-1.15, 1.15); gax.set_aspect("equal")
gax.set_xticks([]); gax.set_yticks([])
for s in gax.spines.values():
    s.set_visible(False)
globe(gax, lat0=18, lon0=30, R=1.0)
chrome(fig, ax, "A — 3D ROTATING GLOBE", "auto-rotate 30s/turn · arcs land on the globe surface · one hero object")
panel(ax, .72, .60, .26, .29, "GEO BLOCKS", STATS)
panel(ax, .72, .28, .26, .29, "NETFLOW", FLOW)
panel(ax, .72, .03, .26, .22, "FEED HEALTH",
      [("influx   OK", "#b02a8f"), ("geoip    OK", "#b02a8f"), ("syslog   OK", "#b02a8f")])
fig.savefig(f"{OUT}/A_globe3d.png", facecolor=BG)
plt.close(fig)

# ---------- B: 2D flat map ----------
fig, ax = fig_base()
mx = fig.add_axes([0.02, 0.30, 0.96, 0.58]); flat_axes(mx)
draw_land_flat(mx)
for lat, lon, lab in SRC:
    pts = bez((lon, lat), (HOME[1], HOME[0]), lift=0.16)
    grad_line(mx, pts, lw=1.7)
    mx.scatter([lon], [lat], s=18, color="#f0f921", zorder=7)
    mx.text(lon, lat + 4, lab, color="#f0f921", fontsize=7.5, ha="center",
            family="monospace", zorder=8)
mx.scatter([HOME[1]], [HOME[0]], s=90, marker="*", color="#f7e225", zorder=9)
chrome(fig, ax, "B — 2D FLAT MAP", "equirectangular · every source visible at once · no hidden hemisphere")
panel(ax, .02, .03, .30, .24, "GEO BLOCKS", STATS)
panel(ax, .35, .03, .30, .24, "NETFLOW", FLOW)
panel(ax, .68, .03, .30, .24, "FEED HEALTH",
      [("influx   OK", "#b02a8f"), ("geoip    OK", "#b02a8f"), ("syslog   OK", "#b02a8f")])
fig.savefig(f"{OUT}/B_flat2d.png", facecolor=BG)
plt.close(fig)

# ---------- C: hybrid ----------
fig, ax = fig_base()
gax = fig.add_axes([0.01, 0.06, 0.56, 0.82]); gax.set_facecolor(BG)
gax.set_xlim(-1.1, 1.1); gax.set_ylim(-1.1, 1.1); gax.set_aspect("equal")
gax.set_xticks([]); gax.set_yticks([])
for s in gax.spines.values():
    s.set_visible(False)
globe(gax, lat0=20, lon0=-35, R=1.0)
mx = fig.add_axes([0.585, 0.56, 0.40, 0.30]); flat_axes(mx)
draw_land_flat(mx, alpha=.9)
for lat, lon, _ in SRC:
    pts = bez((lon, lat), (HOME[1], HOME[0]), lift=0.14)
    grad_line(mx, pts, lw=1.0, alpha=.9)
    mx.scatter([lon], [lat], s=8, color="#f0f921", zorder=7)
mx.scatter([HOME[1]], [HOME[0]], s=45, marker="*", color="#f7e225", zorder=9)
chrome(fig, ax, "C — HYBRID", "globe is the hero · flat mini-map guarantees the far side is never lost")
ax.text(.585, .875, "MINI-MAP · all sources", transform=ax.transAxes, color=DIM,
        fontsize=7.5, weight="bold", family="monospace", zorder=12)
panel(ax, .585, .30, .195, .22, "GEO BLOCKS", STATS[:3], fs=8)
panel(ax, .79, .30, .195, .22, "NETFLOW", FLOW[:3], fs=8)
panel(ax, .585, .05, .40, .21, "FEED HEALTH",
      [("influx  OK   geoip  OK", "#b02a8f"), ("syslog  OK   ipfix  OK", "#b02a8f"),
       ("last write  2s ago", DIM)], fs=8)
fig.savefig(f"{OUT}/C_hybrid.png", facecolor=BG)
plt.close(fig)
print("ok")
