#!/usr/bin/env python3
"""Prove the MILKY WAY BAND against a real page, with numbers.

`js/galaxy.js` claims the band is where the real one is and shaped like the
real one. That claim is checkable, and this is what checks it -- by reading
the baked all-sky map back off the GPU through the page's own
`window.__netviz.milkyway.sample(l, b)`, at real galactic coordinates, and
asserting the relationships that make it the Milky Way rather than a stripe:

  1. THE MAP FINISHES. The bake is spread over eight scissored frames; if it
     never completes, every case below reads a black texture and passes for
     the wrong reason. Asserted first, and asserted as "baking() reached 0",
     not as a sleep.
  2. THE PLANE IS BRIGHT AND THE POLES ARE DARK. b=0 beats b=+-90 by a wide
     margin at several longitudes. This is the one case a painted stripe also
     passes -- it is here to catch a map that failed to render at all.
  3. THE CENTRE OUTSHINES THE ANTICENTRE. Sagittarius over Auriga is the
     single most obvious thing about the real band: a gaussian stripe has no
     idea about it, and an integral through an exponential disk cannot avoid
     it. Measured as a MEAN over a window of the band rather than at one
     point -- the dust filaments are fractal, so any single pixel is a
     lottery, and (l=0, b=0) in particular is one of the most extinguished
     directions in the sky.
  4. THE BRIGHTEST POINT IN THE SKY IS IN SAGITTARIUS. Searched over the
     inner Galaxy rather than assumed: the peak must land within 20 deg of
     l=0 and below the plane, which is where the Large Sagittarius Star Cloud
     is. It must also NOT be at b=0 -- the plane at l=0 is dimmed by the dust
     in front of it, and a model whose peak sits exactly on the plane at the
     centre has no dust lane.
  5. THE BAND CARRIES FURTHER OFF THE PLANE TOWARD THE CENTRE. At 10 deg off
     the plane there is still band at l=0 and almost none at l=180.
  6. THE DARK CLOUDS ARE DARK, each measured against ITSELF with the dust
     layer turned off -- the Cygnus Rift, the Aquila Rift, the Ophiuchus
     clouds and the Coalsack. Comparing a cloud against the sky beside it
     cannot separate "this cloud absorbs" from "the band is fainter over
     there", and the Ophiuchus clouds are 27 deg wide in longitude, which is
     wide enough for that difference to decide the answer. Re-baking without
     dust asks the question directly, and doubles as the proof that the dust
     control does what its help text says.
  7. THE CENTRE IS RED AND THE ANTICENTRE IS NOT. Extinction is
     wavelength-dependent, so the R:B ratio toward Sagittarius must exceed
     the R:B ratio toward Auriga. This is the case that proves the three
     channels are integrated separately rather than tinted at the end.
  8. THE MAGELLANIC CLOUDS ARE THERE, off the band, at their real
     coordinates, and the sky beside them is not -- but NOTHING more than 12
     deg off the plane outshines the band itself. The LMC shipped at 0.16 of
     peak in sky measuring 0.001 and was reported from the wall as "a big
     white spot", which is what an isolated smooth gaussian looks like at
     that contrast.
  9. THE BAND IS BEHIND THE GLOBE. Not a texture case at all -- a pixel one,
     and the regression it exists to catch shipped once: an additive material
     is `transparent`, three draws the whole transparent list AFTER the
     opaque one whatever `renderOrder` says, so a sky shell with depthTest
     off paints straight over the planet and lifts every pixel of it.
     Toggling the layer must change the SKY and leave the GLOBE alone, and
     the two halves are aimed SEPARATELY: once with Sagittarius behind the
     globe (the planet must not move by a level), and once with Sagittarius
     projected into open sky clear of the disc (the frame must). Aiming only
     the first and hoping the rest of the band lands somewhere visible is
     what a first cut did -- it read 56/255 against a synthetic collector and
     1/255 against the deployment ten minutes later, because where the band
     falls on screen depends entirely on which way the wall's camera happens
     to be pointing.

Run against a synthetic collector this tool starts itself:

    python3 tools/verify_milkyway.py

or against a running deployment:

    python3 tools/verify_milkyway.py --url http://collector.example.lan:8099/
"""
import argparse
import io
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageStat
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8198"))
URL = f"http://127.0.0.1:{PORT}/"

FAILURES: list[str] = []


def check(ok: bool, what: str, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {what}{(' -- ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(what)


def sample_mean_rgb(page, box):
    """Mean RGB over a clip rect, 0..255, via a real screenshot -- the same
    method verify_theme.py uses, and for the same reason: the renderer is
    built without `preserveDrawingBuffer`, so a JS-side getImageData reads an
    already-cleared buffer."""
    img = Image.open(io.BytesIO(page.screenshot(clip=box))).convert("RGB")
    return ImageStat.Stat(img).mean


def averaged(page, box, n=4, gap_ms=250):
    rows = []
    for i in range(n):
        rows.append(sample_mean_rgb(page, box))
        if i < n - 1:
            page.wait_for_timeout(gap_ms)
    return [sum(c) / len(rows) for c in zip(*rows)]


def darkest_mean(page, box, n=6, gap_ms=200):
    """Mean of the per-pixel MINIMUM across `n` frames.

    An average will not do here. The feed is live and arcs cross the globe
    constantly, so two averaged samples of the SAME unchanged scene differ by
    up to 10 levels on a channel -- measured -- which is more than the effect
    being looked for. Arcs are bright and transient; the minimum over several
    frames is the sky and the planet with the arcs taken out of it, and it is
    stable to a fraction of a level. The camera walk is stopped by the caller
    for the same reason: it moves which piece of ground is in the box, and
    that is a real change nothing can average away."""
    stack = None
    for i in range(n):
        img = Image.open(io.BytesIO(page.screenshot(clip=box))).convert("RGB")
        stack = img if stack is None else ImageChops.darker(stack, img)
        if i < n - 1:
            page.wait_for_timeout(gap_ms)
    return ImageStat.Stat(stack).mean


def run(page) -> None:
    page.wait_for_function("window.__netvizReady === true", timeout=20_000)
    # The layer ships on, but a stored patch on a real deployment may have
    # turned it off; the map is baked either way, and this is a texture test.
    page.evaluate("() => window.__netviz.settings.apply({'layers.milkyway': true})")

    print("case 1 -- the bake completes")
    page.wait_for_function("() => window.__netviz.milkyway.baking() === 0", timeout=20_000)
    size = page.evaluate("() => [window.__netviz.milkyway.width, window.__netviz.milkyway.height]")
    check(size[0] >= 2048 and size[1] == size[0] // 2,
          "the map is a 2:1 equirectangular texture of at least 2048px", f"{size[0]}x{size[1]}")

    def lum(l: float, b: float) -> float:
        rgb = page.evaluate("([l, b]) => window.__netviz.milkyway.sample(l, b)", [l, b])
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

    def channels(l: float, b: float):
        return page.evaluate("([l, b]) => window.__netviz.milkyway.sample(l, b)", [l, b])

    print("case 2 -- the plane is bright, the poles are dark")
    poles = max(lum(0, 90), lum(0, -90), lum(180, 90))
    for l in (0, 90, 180, 270):
        plane = lum(l, 0)
        check(plane > poles * 4, f"l={l} on the plane beats both poles",
              f"{plane:.4f} vs {poles:.4f}")

    print("case 3 -- the centre outshines the anticentre")

    def band_mean(l0: float) -> float:
        rows = [lum((l0 + dl) % 360, b)
                for dl in (-6, -3, 0, 3, 6)
                for b in (-8, -6, -4, -2, 0, 2, 4, 6, 8)]
        return sum(rows) / len(rows)

    centre, anti = band_mean(0), band_mean(180)
    check(centre > anti * 3, "the Sagittarius window averages far brighter than Auriga's",
          f"{centre:.4f} vs {anti:.4f}")

    print("case 4 -- the brightest thing in the sky is the Sagittarius region")
    peak = page.evaluate('''() => {
      const mw = window.__netviz.milkyway;
      let best = { y: -1 };
      for (let l = 0; l < 360; l += 2) {
        for (let b = -20; b <= 20; b += 1) {
          const c = mw.sample(l, b);
          const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          if (y > best.y) best = { y, l, b };
        }
      }
      return best;
    }''')
    dl = min(abs(peak["l"]), 360 - abs(peak["l"]))
    check(dl <= 20 and peak["b"] < 0,
          "the peak is within 20 deg of l=0 and below the plane",
          f"l={peak['l']} b={peak['b']} lum={peak['y']:.3f}")
    check(peak["y"] < 1.0, "the peak does not clip against the top of the texture",
          f"{peak['y']:.3f}")

    print("case 5 -- the band carries further off the plane toward the centre")
    off_centre, off_anti = lum(0, 10), lum(180, 10)
    check(off_centre > off_anti * 2,
          "10 deg off the plane there is still band at l=0 and little at l=180",
          f"{off_centre:.4f} vs {off_anti:.4f}")

    print("case 6 -- every dark cloud is dust, and the dust control removes it")
    clouds = (("Cygnus Rift", 70.0, 0.5), ("Aquila Rift", 30.0, 5.5),
              ("Ophiuchus clouds", 0.5, 6.0), ("Coalsack", 303.0, -0.5))
    dusty = {name: lum(l, b) for name, l, b in clouds}
    page.evaluate("() => window.__netviz.settings.apply({'appearance.milkyway.dust': 0})")
    page.wait_for_function("() => window.__netviz.milkyway.baking() === 0", timeout=20_000)
    for name, l, b in clouds:
        clear = lum(l, b)
        check(dusty[name] < clear * 0.75, f"the {name} darkens its own patch of band",
              f"{dusty[name]:.4f} with dust, {clear:.4f} without")
    # And put it back, because the cases after this one read a dusty sky.
    page.evaluate("() => window.__netviz.settings.apply({'appearance.milkyway.dust': 1})")
    page.wait_for_function("() => window.__netviz.milkyway.baking() === 0", timeout=20_000)

    print("case 7 -- extinction reddens the centre and not the anticentre")
    cr, cg, cb = channels(0, 0)
    ar, ag, ab = channels(180, 0)
    creds = cr / max(cb, 1e-6)
    areds = ar / max(ab, 1e-6)
    check(creds > areds * 1.2, "R:B toward Sagittarius exceeds R:B toward Auriga",
          f"{creds:.3f} vs {areds:.3f}")

    print("case 8 -- the Magellanic Clouds are where they really are")
    off_band = page.evaluate('''() => {
      const mw = window.__netviz.milkyway;
      let best = { y: -1 };
      for (let l = 0; l < 360; l += 1) {
        for (let b = -88; b <= 88; b += 1) {
          if (Math.abs(b) < 12) continue;
          const c = mw.sample(l, b);
          const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          if (y > best.y) best = { y, l, b };
        }
      }
      return best;
    }''')
    check(off_band["y"] < centre * 0.5,
          "nothing off the band outshines the band",
          f"brightest off-band point l={off_band['l']} b={off_band['b']} "
          f"lum={off_band['y']:.3f} vs the Sagittarius window's {centre:.3f}")
    for name, l, b in (("LMC", 280.5, -32.9), ("SMC", 302.8, -44.3)):
        here = lum(l, b)
        near = (lum(l + 12, b) + lum(l - 12, b)) / 2
        check(here > near * 1.5, f"the {name} stands above the sky beside it",
              f"{here:.4f} vs {near:.4f}")


def case9(page) -> None:
    print("case 9 -- the band is behind the globe, not over it")
    # Turn the sky so Sagittarius is behind the planet. This poked the layer's
    # own rotation on purpose: waiting for sidereal time to bring the band
    # round is a seven-hour test.
    aimed = page.evaluate("""async () => {
      const sf = await import('/js/starfield.js');
      const nv = window.__netviz, p = nv.camera.position;
      const n = Math.hypot(p.x, p.y, p.z);
      const away = [-p.x / n, -p.y / n, -p.z / n];
      let best = { score: 1e9 };
      for (let deg = 0; deg < 360; deg += 0.5) {
        const a = -deg * Math.PI / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        const v = [away[0] * ca - away[2] * sa, away[1], away[0] * sa + away[2] * ca];
        const [l, b] = sf.vecToGalactic(v);
        const dl = Math.min(Math.abs(l), 360 - Math.abs(l));
        const score = Math.abs(b) * 2 + dl;
        if (score < best.score) best = { score, deg, l, b };
      }
      nv.milkyway.group.rotation.y = best.deg * Math.PI / 180;
      return best;
    }""")
    check(abs(aimed["b"]) < 3, "the band was aimed at the globe",
          f"l={aimed['l']:.1f} b={aimed['b']:.1f}")

    box = page.evaluate("""() => {
      const c = document.querySelector('canvas').getBoundingClientRect();
      return { x: c.x, y: c.y, w: c.width, h: c.height };
    }""")
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    # The globe is always centered -- the camera looks at its origin every
    # frame -- so a box on the middle of the canvas is a box on the planet.
    globe_box = {"x": cx - 160, "y": cy - 160, "width": 320, "height": 320}
    full_box = {"x": box["x"], "y": box["y"], "width": box["w"], "height": box["h"]}

    # Both frames are rendered by hand, from a STOPPED animation loop. This
    # is the only way to get an A/B here: with the loop running, the camera
    # moves, arcs come and go and the globe turns between two captures, and
    # measured, two samples of an unchanged scene differ by up to 10 levels
    # on a channel -- twice the effect being looked for. With the loop
    # stopped, nothing at all differs between the two frames except the layer.
    # It costs the bloom pass (this renders the scene, not the composer),
    # which is fine: bloom cannot put the sky in front of the planet.
    # This browser page is the verifier's own; a wall display in another
    # browser is untouched.
    page.evaluate("""() => {
      const nv = window.__netviz;
      nv.renderer.setAnimationLoop(null);
    }""")
    page.wait_for_timeout(200)

    def frame(on: bool):
        page.evaluate("""(v) => {
          const nv = window.__netviz;
          nv.milkyway.group.visible = v;
          nv.renderer.render(nv.scene, nv.camera);
        }""", on)
        return (sample_mean_rgb(page, globe_box),
                Image.open(io.BytesIO(page.screenshot(clip=full_box))).convert("L"))

    globe_on, _ = frame(True)
    globe_off, _ = frame(False)
    globe_delta = max(abs(a - b) for a, b in zip(globe_on, globe_off))

    # Second aim: put the Galactic centre in OPEN SKY, clear of the globe's
    # silhouette, and check the frame actually changes. The globe's screen
    # radius comes from the camera's own geometry rather than from counting
    # pixels, so this holds at any zoom or aspect.
    shown = page.evaluate("""async () => {
      const sf = await import('/js/starfield.js');
      const nv = window.__netviz, cam = nv.camera;
      const h = nv.renderer.domElement.height;
      const d = Math.hypot(cam.position.x, cam.position.y, cam.position.z);
      const halfFov = (cam.fov * Math.PI / 180) / 2;
      const globePx = (h / 2) * Math.tan(Math.asin(1.0 / d)) / Math.tan(halfFov);
      const gc = sf.GALACTIC_X;
      let best = { clearance: -1 };
      for (let deg = 0; deg < 360; deg += 1) {
        const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        // The same rotation.y the group carries, applied to the centre's
        // direction, then projected the way the renderer would.
        const v = { x: gc[0] * ca + gc[2] * sa, y: gc[1], z: -gc[0] * sa + gc[2] * ca };
        const p = new nv.camera.position.constructor(v.x * 95, v.y * 95, v.z * 95).project(cam);
        if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9 || p.z > 1) continue;
        const px = p.x * nv.renderer.domElement.width / 2;
        const py = p.y * h / 2;
        const clearance = Math.hypot(px, py) - globePx;
        if (clearance > best.clearance) best = { clearance, deg, globePx };
      }
      if (best.clearance > 0) nv.milkyway.group.rotation.y = best.deg * Math.PI / 180;
      return best;
    }""")
    check(shown["clearance"] > 0,
          "the Galactic centre can be put in open sky at this camera",
          f"clearance {shown['clearance']:.0f}px past a {shown['globePx']:.0f}px globe")

    _, full_on = frame(True)
    _, full_off = frame(False)
    frame(True)
    diff = ImageChops.difference(full_on, full_off)
    sky_delta = ImageStat.Stat(diff).extrema[0][1]
    check(sky_delta > 8, "the band really is in frame with the layer on",
          f"brightest sky pixel rose {sky_delta}/255")
    # 0.3/255 -- effectively zero, and it can be that tight because the two
    # frames are the same frame with one object hidden. The failure this
    # catches lifted the globe by tens of levels.
    check(globe_delta < 0.3, "the globe is not lifted by the layer at all",
          f"globe mean moved {globe_delta:.1f}/255")
    depth = page.evaluate(
        "() => { const m = window.__netviz.milkyway.mesh.material;"
        " return { depthTest: m.depthTest, depthWrite: m.depthWrite }; }")
    check(depth["depthTest"] and not depth["depthWrite"],
          "the shell depth-tests against the globe and writes no depth of its own",
          str(depth))


def case10(page) -> None:
    print("case 10 -- the layer adds no per-pixel grain")
    box = page.evaluate("""() => {
      const c = document.querySelector('canvas').getBoundingClientRect();
      return { x: c.x + 20, y: c.y + 20, width: 200, height: 200 };
    }""")

    def high_frequency() -> float:
        """Spread of what a 1.5px blur removes: grain, not structure."""
        vals = []
        for _ in range(3):
            img = Image.open(io.BytesIO(page.screenshot(clip=box))).convert("L")
            residual = ImageChops.difference(img, img.filter(ImageFilter.GaussianBlur(1.5)))
            vals.append(ImageStat.Stat(residual).stddev[0])
            page.wait_for_timeout(200)
        return sum(vals) / len(vals)

    def with_layer(on: bool) -> float:
        page.evaluate("(v) => window.__netviz.settings.apply({'layers.milkyway': v})", on)
        page.wait_for_timeout(500)
        return high_frequency()

    off = with_layer(False)
    on = with_layer(True)
    # 0.35, between the 0.12 a correct build measures and the 0.83 the
    # constant dither measured on the same wall. Stars are in both numbers
    # and are the reason this compares the CHANGE rather than the value.
    check(on - off < 0.35, "the layer adds no grain to the sky",
          f"high-frequency energy {off:.2f} -> {on:.2f} (+{on - off:.2f})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None, help="verify a running collector instead")
    ap.add_argument("--keep", action="store_true", help="leave the browser open")
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
            browser = p.chromium.launch(headless=not args.keep,
                                        args=["--use-gl=angle", "--use-angle=swiftshader",
                                              "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1600, "height": 900})
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            run(page)
            # case 10 first: it measures through the composer and needs the
            # animation loop, which case 9 stops and cannot restart.
            case10(page)
            case9(page)
            browser.close()
    finally:
        if collector:
            os.killpg(os.getpgid(collector.pid), signal.SIGTERM)
            collector.wait(timeout=10)

    for line in errors:
        print(f"  console: {line}")
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("\nall cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
