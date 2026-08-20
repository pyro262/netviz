#!/usr/bin/env python3
"""Prove the RAYMARCHED AURORA against a real page, with numbers.

0.7.0 replaced a single shell at 1.03R with a volume marched between 1.016R and
1.05R. Every claim that change makes is about geometry a screenshot of the front
of the globe cannot settle, so this file reads the drawn pixels back and asks
about them directly.

  1. THE OVAL IS ON THE NIGHT SIDE. The brightest aurora-colored pixel,
     unprojected onto the globe, must face away from the sun. Drawing an aurora
     in daylight is the single most visible way to draw a fake one.
  2. IT STANDS UP AT THE LIMB. With a magnetic pole on the limb there must be
     lit aurora pixels OUTSIDE the globe's silhouette, at a radius the shell's
     own altitudes predict. A FLAT SHELL SCORES ZERO HERE, which is the whole
     regression this case exists to catch.
  3. GREEN BELOW RED, RADIALLY. In that same limb view the inner ring of
     aurora pixels must be greener than the outer and the outer redder than the
     inner. The bins are RADIAL on purpose: the old shader faked the split
     across latitude, so a latitudinal version of this case passes it by
     accident.
  4. THE PLANET OCCLUDES. A point on the FAR-side oval must project to
     background. An additive shell with depthTest ON loses its near-side
     fragments and with it OFF paints the far side through the Earth; both
     failures are invisible in any single view from the front, and only one of
     them looks wrong to a person.
  5. THE NIGHTSIDE OFFSET IS REALLY THERE. `ovalEdge(kp, 0)` must sit
     equatorward of `ovalEdge(kp, 12)`, read through the page's own module
     rather than recomputed here -- a second copy of the arithmetic in Python
     could agree with itself while disagreeing with the shader.
  6. NO READING, NO AURORA. Kp 0 is a real, very quiet sky; "cannot reach NOAA"
     is not, and confusing the two is the failure the whole polling design is
     built around.

HOW THE PIXELS ARE READ, and why it is not a screenshot. The renderer is built
without `preserveDrawingBuffer`, so a JS-side `getImageData` reads an empty
canvas -- which is why verify_theme.py and verify_milkyway.py go through
`page.screenshot`. That path runs through the browser's compositor, and on this
host's software rasterizer it is both slow (7-20s a capture, measured) and prone
to stalling outright after three or four of them. So main.js exposes a one-shot
`window.__netvizGrab` callback invoked IMMEDIATELY after `composer.render()`,
while the default framebuffer is still valid, and this file reads the pixels
with `gl.readPixels` from inside it. Same pixels, no compositor.

    python3 tools/verify_aurora.py
    python3 tools/verify_aurora.py --url http://HOST:8099/
"""
import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8197"))
URL = f"http://127.0.0.1:{PORT}/"

# A pixel counts as aurora when it is brighter than this and its hue is in the
# green-through-violet range the two emission colors span. Set against a
# measured floor rather than taste: the synthetic sky sits under 12/255 on every
# channel with the aurora off, and the arcs -- the other bright thing in frame --
# are excluded by hue, not by brightness.
LIT_MIN = 26

FAILURES: list[str] = []


def check(ok: bool, what: str, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {what}{(' -- ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(what)


def quiet_the_scene(page) -> None:
    """Stop everything that moves between two captures.

    THE MEASUREMENT BELOW IS A DIFFERENCE between two frames, so anything that
    changes on its own turns into signal. The camera walks continuously, arcs
    are Poisson-driven and are the brightest thing in frame, and lightning
    flashes -- so the walk is stopped, the flow rate goes to its schema floor
    and the pool is cleared before each capture, and lightning goes off. Exactly
    the discipline verify_theme.py's case 3 arrived at for the same reason."""
    page.evaluate("""() => window.__netviz.settings.apply({
      'camera.walk.enabled': false,
      'traffic.flowsPerSecond': 1,
      'layers.lightning': false,
      'layers.clouds': false,
    })""")
    # The walk setting alone is not enough: the rig eases toward whatever it was
    # last aimed at, and it re-arms on its own idle timer. `poke` is what every
    # menu opener uses to hold the camera manual, and it is the only handle
    # this script has on the rig from outside.
    page.evaluate("() => window.__netviz.rig.poke(3600)")
    page.wait_for_timeout(1200)


def grab(page, name: str, timeout_ms: int = 20000) -> None:
    """Capture the drawn frame INTO THE PAGE, under a name, and leave it there.

    The buffer stays in JavaScript on purpose: at 1280x720 it is 3.7 million
    bytes, and handing that to Python through CDP as JSON takes longer than the
    render it came from -- the first cut of this file did exactly that and timed
    out before a single case ran. Every case runs its own small analysis in the
    page and returns a summary of tens of numbers.

    Row 0 is at the BOTTOM -- readPixels' own origin, kept rather than flipped
    so the coordinates here match what WebGL reports and NDC's y agrees without
    a sign flip at each call site.

    The arc pool is cleared first: it refills even at the floor rate, so a frame
    taken later in a run would carry more arcs than one taken early, and that
    drift lands squarely in the difference this file measures."""
    page.evaluate("() => window.__netviz.arcs.rebuild()")
    page.wait_for_timeout(300)
    page.evaluate("""(n) => {
      window.__grabs = window.__grabs || {};
      window.__grabDone = false;
      window.__netvizGrab = (gl) => {
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        window.__grabs[n] = {w, h, px: buf};
        window.__grabDone = true;
      };
    }""", name)
    page.wait_for_function("window.__grabDone === true", timeout=timeout_ms)


# WHAT COUNTS AS AN AURORA PIXEL, and why it is not a hue test.
#
# The first cut of this file classified by color: bright, and not red-dominant.
# That is wrong and measurably so -- it reported 31,567 "aurora" pixels on a
# frame with NO READING AT ALL, because the globe's night side, the atmosphere
# shell and the stars are all bright and all blue-leaning. A verifier that
# measures the sky and calls it aurora is the "guard that passes everything"
# failure this project has already shipped twice.
#
# So the aurora is defined as WHAT CHANGED: the same pixel, with a storm and
# without one, differing by more than the frame's own noise. Nothing has to be
# guessed about its color, and case 3 can then ask about that color honestly.
DIFF_MIN = 12

DIFF_JS = f"""
  const DIFF_MIN = {DIFF_MIN};
  const A = window.__grabs.storm, B = window.__grabs.quiet;
  const w = A.w, h = A.h, pa = A.px, pb = B.px;
  const lift = (i) => (pa[i] - pb[i]) + (pa[i + 1] - pb[i + 1]) + (pa[i + 2] - pb[i + 2]);
  const isAurora = (i) => lift(i) >= DIFF_MIN;
"""


def analyze(page, body: str, arg=None):
    """Run a small analysis over the two captured frames, in the page."""
    return page.evaluate(f"""(arg) => {{
      {DIFF_JS}
      {body}
    }}""", arg)


def globe_disc(page):
    """The globe's silhouette in DRAWING-BUFFER pixels, bottom-up.

    Computed from the live camera rather than found in the image: a radius
    measured off a brightness threshold would be measuring the atmosphere
    shell's falloff as often as the planet."""
    return page.evaluate("""() => {
      const {camera, renderer} = window.__netviz;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = camera.position.length();
      const ang = Math.asin(Math.min(1, 1.0 / d));           // sphere of radius 1
      const halfFovY = (camera.fov * Math.PI / 180) / 2;
      return {cx: w / 2, cy: h / 2, r: (Math.tan(ang) / Math.tan(halfFovY)) * (h / 2),
              w, h};
    }""")


def set_reading(page, kp, stale=False):
    return page.evaluate("(a) => window.__netviz.aurora.__setReading(a)",
                         {"kp": kp, "stale": stale})


def settle(page, ms=1500):
    page.wait_for_timeout(ms)


def capture_pair(page) -> None:
    """The two frames every measurement below is a difference of.

    QUIET FIRST, then the storm: `__setReading({kp: null})` is not a quiet sky,
    it is NO READING, which is what the polling design draws nothing for -- so
    the baseline frame has no aurora in it at all rather than a faint one that
    would subtract away part of the signal."""
    set_reading(page, None)
    settle(page)
    grab(page, "quiet")
    set_reading(page, 8)
    settle(page)
    grab(page, "storm")


def case1_night_side(page) -> None:
    """1: the oval is drawn on the night side."""
    out = analyze(page, """
      const {camera, globe} = window.__netviz;
      const THREE = window.__netvizTHREE;
      const sun = globe.material.uniforms.sunDir.value;
      // The pixels the storm lifted MOST: a faint tail near the terminator says
      // nothing either way, and the claim is about where the OVAL is.
      let best = [];
      for (let y = 0; y < h; y += 3) {
        for (let x = 0; x < w; x += 3) {
          const i = (y * w + x) * 4;
          if (!isAurora(i)) continue;
          best.push([x, y, lift(i)]);
        }
      }
      if (!best.length) return {night: 0, total: 0};
      best.sort((p, q) => q[2] - p[2]);
      best = best.slice(0, Math.max(1, Math.floor(best.length / 20)));
      let night = 0;
      for (const [x, y] of best) {
        // readPixels is bottom-up and NDC's y is too, so no flip is needed.
        const ndc = new THREE.Vector3((x / w) * 2 - 1, (y / h) * 2 - 1, 0.5);
        ndc.unproject(camera);
        const dir = ndc.sub(camera.position).normalize();
        const t = -camera.position.dot(dir);
        const pt = camera.position.clone().addScaledVector(dir, t);
        globe.group.worldToLocal(pt);
        if (pt.normalize().dot(sun) < 0.10) night += 1;
      }
      return {night, total: best.length};
    """)
    if not out["total"]:
        check(False, "1: the oval is on the night side",
              "the storm lifted no pixels at all at Kp 8")
        return
    frac = out["night"] / out["total"]
    check(frac > 0.8, "1: the oval is on the night side",
          f"{out['night']}/{out['total']} of the most-lifted pixels face away from "
          f"the sun ({frac * 100:.0f}%, want >80%)")


def case2_stands_up_at_the_limb(page):
    """2: the curtains stand off the disc. Returns the radial bins for case 3."""
    disc = globe_disc(page)
    out = analyze(page, """
      const {cx, cy, rad} = arg;
      const band = [];
      let total = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          if (!isAurora(i)) continue;
          total += 1;
          const rr = Math.hypot(x - cx, y - cy) / rad;
          // The shell tops out at 1.05R, so past ~1.075 disc radii is not this
          // layer -- a wider window counts the atmosphere shell instead.
          if (rr > 1.002 && rr < 1.075) {
            band.push([rr, pa[i] - pb[i], pa[i + 1] - pb[i + 1], pa[i + 2] - pb[i + 2]]);
          }
        }
      }
      band.sort((p, q) => p[0] - q[0]);
      return {total, band};
    """, {"cx": disc["cx"], "cy": disc["cy"], "rad": disc["r"]})
    band = out["band"]
    if len(band) < 40:
        check(False, "2: the curtains stand off the disc at the limb",
              f"only {len(band)} lifted pixels outside the silhouette; "
              f"{out['total']} lifted in total")
        return band
    # BOTH NUMBERS, and the floor of 40 this case shipped with was too low --
    # measured against an injected break that collapsed R_INNER to 1.0495 (a
    # shell with no height at all), which still scored 101-142 pixels outside
    # the disc simply because the shell itself is outside it.
    #
    # THE COUNT IS THE DISCRIMINATOR: clean runs measure 1143-2048, the flat
    # shell 101-142, so 400 sits with a wide margin either side. The spread is a
    # SECOND and weaker guard, against a different failure -- every lifted pixel
    # landing in one thin ring. It did NOT separate the flat break (0.070
    # against a clean 0.073), because a handful of stray pixels is enough to
    # widen it; it is kept because a genuinely single-radius result would be
    # invisible to the count alone, and saying which number did the work matters
    # more than having two that look like they both did.
    lo, hi = band[0][0], band[-1][0]
    spread = hi - lo
    check(len(band) >= 400 and spread >= 0.015,
          "2: the curtains stand off the disc at the limb",
          f"{len(band)} lifted pixels outside the silhouette (want >=400; a "
          f"height-less shell scores ~120), spanning {lo:.4f}..{hi:.4f} disc "
          f"radii = {spread:.4f} of spread (want >=0.015); {out['total']} lifted "
          f"in total")
    return band


def case3_green_below_red(page, band) -> None:
    """3: green at the base, red at the top -- binned RADIALLY.

    On the LIFT, not on the absolute pixel: the sky behind the limb is not
    neutral, so an absolute reading measures the sky's color as much as the
    aurora's. The bins are radial because the old shader faked this split across
    latitude, so a latitudinal version of this case passes it by accident."""
    if len(band) < 40:
        check(False, "3: green below red, radially", "case 2 found too few pixels")
        return
    half = len(band) // 2

    def lead(sub):
        g = sum(o[2] for o in sub) / len(sub)
        r = sum(o[1] for o in sub) / len(sub)
        return g - r

    inner, outer = lead(band[:half]), lead(band[half:])
    check(inner > outer, "3: green below red, radially",
          f"inner ring g-r={inner:+.1f}, outer ring g-r={outer:+.1f} "
          f"(the inner must lead; the split is on ALTITUDE, not latitude)")


def far_side_oval_points(page):
    """Screen positions of points ON THE FAR-SIDE OVAL, in drawing-buffer
    pixels, bottom-up.

    NOT the disc's centre, which is what a first cut of this case sampled and
    which is why it stayed green under an injected break: the sub-camera point
    is at some mid-latitude, and no far-side oval projects anywhere near it. The
    leak this case exists for appears exactly where the hidden oval lies, so
    that is where it has to look.

    Points are taken around the dipole axis at the oval's own colatitude and
    kept only when they face AWAY from the camera and still project inside the
    disc -- which is the definition of "behind the planet from here"."""
    return page.evaluate("""() => {
      const {camera, globe, renderer, oval} = window.__netviz;
      const THREE = window.__netvizTHREE;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const a = oval.dipoleAxis();
      const axis = new THREE.Vector3(a.x, a.y, a.z).normalize();
      // Any vector perpendicular to the axis, to sweep the ring with.
      const seed = Math.abs(axis.y) < 0.9
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(axis, seed).normalize();
      const v = new THREE.Vector3().crossVectors(axis, u).normalize();
      const out = [];
      for (const hemi of [1, -1]) {
        const m = axis.clone().multiplyScalar(hemi);
        const mu = new THREE.Vector3().crossVectors(m, seed).normalize();
        const mv = new THREE.Vector3().crossVectors(m, mu).normalize();
        // Colatitude 25 deg: inside the oval for any Kp this file drives.
        const col = 25 * Math.PI / 180;
        for (let i = 0; i < 72; i++) {
          const t = (i / 72) * Math.PI * 2;
          const n = m.clone().multiplyScalar(Math.cos(col))
            .addScaledVector(mu, Math.sin(col) * Math.cos(t))
            .addScaledVector(mv, Math.sin(col) * Math.sin(t));
          // At the aurora's own altitude, in world space.
          const world = n.clone().multiplyScalar(1.03);
          globe.group.localToWorld(world);
          const toCam = camera.position.clone().sub(world);
          // FAR side only: the surface normal points away from the camera.
          const nWorld = world.clone().sub(globe.group.position).normalize();
          if (nWorld.dot(toCam.clone().normalize()) > -0.25) continue;
          const p = world.clone().project(camera);
          if (Math.abs(p.x) > 0.98 || Math.abs(p.y) > 0.98) continue;
          out.push([Math.round((p.x + 1) / 2 * w), Math.round((p.y + 1) / 2 * h)]);
        }
      }
      return out;
    }""")


def case4_planet_occludes(page) -> None:
    """4: the far-side oval is not visible through the planet."""
    pts = far_side_oval_points(page)
    if len(pts) < 8:
        check(False, "4: the planet occludes the far-side oval",
              f"only {len(pts)} far-side oval points were on screen to sample")
        return
    out = analyze(page, """
      let leaked = 0, n = 0, worst = 0;
      for (const [x, y] of arg) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((y + dy) * w + (x + dx)) * 4;
            if (i < 0 || i + 3 >= pa.length) continue;
            n += 1;
            worst = Math.max(worst, lift(i));
            if (isAurora(i)) leaked += 1;
          }
        }
      }
      return {leaked, n, worst};
    """, pts)
    if not out["n"]:
        check(False, "4: the planet occludes the far-side oval",
              "every sample fell off screen")
        return
    frac = out["leaked"] / out["n"]
    check(frac <= 0.05, "4: the planet occludes the far-side oval",
          f"{out['leaked']}/{out['n']} pixels where the HIDDEN oval projects were "
          f"lifted by the storm ({frac * 100:.1f}%, want <=5%), worst lift "
          f"{out['worst']} -- depthTest on loses the near side, off paints "
          f"through the Earth")


def case5_nightside_offset(page) -> None:
    """5: the oval reaches further equatorward at magnetic midnight."""
    out = page.evaluate("""() => {
      const o = window.__netviz.oval;
      return {midnight: o.ovalEdge(4, 0), noon: o.ovalEdge(4, 12),
              thickMid: o.ovalThickness(0), thickNoon: o.ovalThickness(12),
              collector: 66.5 - 1.7 * 4};
    }""")
    lower = out["midnight"] < out["noon"] - 3.0
    agrees = abs(out["noon"] - out["collector"]) < 1e-9
    thicker = out["thickMid"] > out["thickNoon"]
    check(lower and agrees and thicker, "5: the nightside offset is really there",
          f"edge at midnight {out['midnight']:.2f} vs noon {out['noon']:.2f} "
          f"(lower={lower}); noon equals the collector's {out['collector']:.2f} "
          f"exactly={agrees}; band thicker at midnight={thicker}")


def case6_no_reading_no_aurora(page) -> None:
    """6: no reading is not the same as a quiet sky.

    Measured against a SECOND no-reading frame, so what is asserted is that two
    frames with no aurora in them differ only by the renderer's own frame-to-
    frame noise. Kp 0 is a real, very quiet sky; 'cannot reach NOAA' is not, and
    confusing the two is the failure the whole polling design is built around.

    This case also calibrates the threshold every case above uses: if the noise
    floor between two identical frames were anywhere near DIFF_MIN, none of
    those measurements would mean anything."""
    set_reading(page, None)
    settle(page)
    grab(page, "storm")          # deliberately the same state as `quiet`
    visible = page.evaluate("() => window.__netviz.aurora.visible()")
    n = analyze(page, """
      let n = 0, worst = 0;
      for (let y = 0; y < h; y += 3) {
        for (let x = 0; x < w; x += 3) {
          const i = (y * w + x) * 4;
          worst = Math.max(worst, lift(i));
          if (isAurora(i)) n += 1;
        }
      }
      return {n, worst};
    """)
    # Put a real reading back, so a later run starts from a live sky rather than
    # from this case's leftovers.
    set_reading(page, 3)
    check(not visible and n["n"] < 40, "6: no reading means no aurora",
          f"mesh visible={visible} (must be False); two no-reading frames differ "
          f"in {n['n']} sampled pixels, worst lift {n['worst']} against a "
          f"threshold of {DIFF_MIN}")


def run(page) -> None:
    quiet_the_scene(page)
    capture_pair(page)
    case1_night_side(page)
    band = case2_stands_up_at_the_limb(page)
    case3_green_below_red(page, band)
    case4_planet_occludes(page)
    case5_nightside_offset(page)
    case6_no_reading_no_aurora(page)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None, help="verify a running collector instead")
    args = ap.parse_args()

    collector = None
    url = args.url
    if not url:
        env = dict(os.environ, PYTHONUNBUFFERED="1", NETVIZ_WS_PORT=str(PORT))
        collector = subprocess.Popen([sys.executable, "-m", "netviz.main", "--synthetic"],
                                     cwd=REPO, env=env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, start_new_session=True)
        time.sleep(2.0)
        if collector.poll() is not None:
            sys.stderr.write(collector.stderr.read().decode())
            return 1
        url = URL

    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                              "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=30_000)
            time.sleep(2.0)
            # three is not on `window`; the cases need a Vector3 to unproject
            # with, and importing it in the page is the honest way to get the
            # SAME build the renderer is using rather than a second copy.
            page.evaluate("""async () => {
              window.__netvizTHREE = await import('three');
            }""")
            run(page)
            browser.close()
    finally:
        if collector:
            os.killpg(os.getpgid(collector.pid), signal.SIGTERM)
            collector.wait(timeout=10)

    for line in errors:
        print(f"  console: {line}")
    total = 6
    passed = total - len(FAILURES)
    print(f"\nsummary: {passed}/{total} cases passed")
    print("errors:", errors[:5] or "none")
    return 1 if (FAILURES or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
