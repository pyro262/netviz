#!/usr/bin/env python3
"""Prove the walk's span and its ramp -- and the ripple's colour -- against a
real page.

The unit suite proves `walkRateAt` integrates to `spanDegrees` and that
`step()` never carries the target past the span. What it cannot prove is
that the RENDERED camera obeys either: `curLat`/`curLon` ease toward the
target, `camera.js` clamps distance and latitude of its own, and the walk
phase's length is decided by a return leg that ends on arrival. So this
samples the rig the page is actually running.

Timing note, carried over from tools/verify_menu.py: the render loop's
`dt = Math.min(0.1, now - last)` clamp throws away the excess when frames
are slower than 10fps, so under headless swiftshader with the synthetic
feed running, SIMULATED time falls behind wall-clock time -- measured at
~3x during the menu work. Nothing here assumes a cycle takes 120 seconds
of wall clock; every case reads the rig's own phase and its own
`walkOrigin`, and the sampling window is sized generously rather than
computed from `cycleSeconds`.

    python3 tools/verify_walk.py
    python3 tools/verify_walk.py --url http://HOST:8099/
"""
import argparse
import math
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8399"))

# A CAP on the sampling, not a duration: the loop stops as soon as one whole
# walk phase has been seen. Simulated time runs ~3x behind wall time under
# headless swiftshader with the feed running, so a fixed 150s window contained
# less than half a walk phase -- measured, first cut of this script.
SAMPLE_SECONDS = 900
SAMPLE_INTERVAL = 0.25

RESULTS: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    RESULTS.append((name, ok, detail))
    return ok


def great_circle_deg(lat1, lon1, lat2, lon2) -> float:
    a, b = math.radians(lat1), math.radians(lat2)
    d = (math.sin(a) * math.sin(b)
         + math.cos(a) * math.cos(b) * math.cos(math.radians(lon2 - lon1)))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


def sample(page):
    return page.evaluate("""() => {
      const s = window.__netviz.rig.state;
      const v = window.__netviz.rig.view();
      return {phase: s.phase, phaseT: s.phaseT, lat: v.lat, lon: v.lon,
              originLat: s.walkOriginLat, originLon: s.walkOriginLon,
              walkDuration: s.walkDuration};
    }""")


def walk_stretches(samples):
    """Contiguous runs of walk samples, keeping only the COMPLETE ones.

    A run clipped by the start or the end of the sampling window carries
    half a ramp, and comparing half a ramp's halves says nothing about the
    ramp -- which is the whole of case 2.
    """
    runs, cur = [], None
    for i, s in enumerate(samples):
        if s["phase"] == "walk":
            if cur is None:
                cur = {"start": i, "rows": []}
            cur["rows"].append(s)
        elif cur is not None:
            cur["end"] = i
            runs.append(cur)
            cur = None
    return [r for r in runs
            if r["start"] > 0 and "end" in r and len(r["rows"]) >= 20]


def path_length(rows) -> float:
    total = 0.0
    for a, b in zip(rows, rows[1:]):
        total += great_circle_deg(a["lat"], a["lon"], b["lat"], b["lon"])
    return total


def run(page) -> bool:
    ok = True
    # config.js is a module the page already loaded, so this import is the
    # same instance the renderer is running -- including anything
    # /config.json merged over it. Nothing is exposed on window for it.
    cfgvals = page.evaluate("""async () => {
      const m = await import('./js/config.js');
      return {span: m.cfg('camera.walk.spanDegrees'), home: m.CONFIG.home || null};
    }""")
    span, home = cfgvals["span"], cfgvals["home"]

    # --------------------------------------------------------- case 4 --
    # Run this FIRST: the ripple cooldown is 2 minutes per target per class,
    # and the synthetic feed lands flows on home continuously, so a target
    # chosen after 150s of sampling might already be inside somebody's cell.
    # A deliberately remote destination keeps it out of the feed's way.
    ok &= ripple_colour_case(page)

    # ------------------------------------------------ cases 1, 2 and 3 --
    print(f"sampling camera state until a whole walk phase has run "
          f"(span={span}, home={home}, cap {SAMPLE_SECONDS}s) ...")
    samples = []
    t0 = time.time()
    while time.time() - t0 < SAMPLE_SECONDS:
        samples.append(sample(page))
        time.sleep(SAMPLE_INTERVAL)
        # Stop as soon as one COMPLETE walk phase is in hand. Sizing this
        # window in wall clock is exactly what cannot be done: simulated time
        # runs behind wall time by a factor that depends on how loaded the
        # machine is -- measured ~3x here, so a 150s window contained less
        # than half a walk. Waiting on the rig's own phase transitions is the
        # same lesson verify_menu.py case 10 records.
        if walk_stretches(samples):
            break

    walking = [s for s in samples if s["phase"] == "walk"]
    # The guard is on the distance from where the walk SET OFF, not from
    # home: campath.js knows nothing about home, and the focus it came back
    # to is the traffic centroid, which drifts.
    worst = max((great_circle_deg(s["lat"], s["lon"],
                                  s["originLat"], s["originLon"])
                 for s in walking), default=0.0)
    # 3 deg of allowance is the eased curLat/curLon trailing its target, not
    # slack in the guard itself.
    ok &= report("1: the camera never leaves the span",
                 bool(walking) and worst <= span + 3,
                 f"worst {worst:.1f} deg from the walk's origin, "
                 f"cap {span} + 3, walk samples {len(walking)}")

    stretches = walk_stretches(samples)
    ratios = []
    for r in stretches:
        rows = r["rows"]
        half = len(rows) // 2
        first = path_length(rows[:half + 1])
        second = path_length(rows[half:])
        ratios.append(second / first if first > 1e-6 else float("inf"))
    ok &= report("2: the walk starts slower than it finishes",
                 bool(ratios) and all(x >= 2.0 for x in ratios),
                 f"{len(ratios)} complete walk phase(s), second/first halves "
                 + ", ".join(f"{x:.2f}" for x in ratios))

    reach = max((great_circle_deg(s["lat"], s["lon"],
                                  s["originLat"], s["originLon"])
                 for s in walking), default=0.0)
    ok &= report("3: the walk still moves",
                 reach >= 25,
                 f"furthest {reach:.1f} deg from the walk's origin")
    return ok


def ripple_colour_case(page) -> bool:
    """A ripple is drawn in its ARC's colour, not its class's own.

    The discriminator has to be a class whose two colours differ, or the
    case passes whatever the code does: the block ring and the block arc are
    both plasmaAt(0.86) * 0.74 and would agree either way. Flow does not --
    the arc is plasmaAt(0.30) and RIPPLE.flow was plasmaAt(0.34).
    """
    result = page.evaluate("""async () => {
      const {arcs, ripples} = window.__netviz;
      const want = arcs.classColour('flow').getHex();
      // Somewhere the synthetic feed does not land on, so the two-minute
      // per-cell cooldown cannot swallow the ring being measured.
      const ev = {k: 'flow', s: '203.0.113.9', d: '198.51.100.7',
                  sll: [-40, 150], dll: [-45, 160], b: 1000};
      arcs.spawn(ev, 'flow');
      const t0 = performance.now();
      // The page's own render loop drives update(); just wait for the head
      // to arrive rather than stepping it here. The live feed is landing its
      // own arcs throughout, so the ring is identified by WHERE it landed,
      // not by being the most recent one -- the first cut of this case read
      // a highlight-class ring from the feed and reported its colour.
      while (performance.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 100));
        const r = ripples.lastRipple();
        if (r && Math.abs(r.lat - ev.dll[0]) < 0.01 && Math.abs(r.lon - ev.dll[1]) < 0.01) {
          return {want, got: r.colour, waited: performance.now() - t0};
        }
      }
      return {want, got: null, waited: performance.now() - t0};
    }""")
    got, want = result["got"], result["want"]
    return report(
        "4: a ripple takes its arc's colour",
        got is not None and got == want,
        f"ring #{got:06x} vs arc #{want:06x}" if got is not None
        else "no ripple was drawn within 20s")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None,
                    help="verify against an already-running collector instead "
                         "of starting a synthetic one locally")
    args = ap.parse_args()

    col = None
    url = args.url
    if not url:
        env = dict(os.environ, PYTHONUNBUFFERED="1", NETVIZ_WS_PORT=str(PORT))
        col = subprocess.Popen([sys.executable, "-m", "netviz.main", "--synthetic"],
                               cwd=REPO, env=env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, start_new_session=True)
        time.sleep(2.5)
        url = f"http://127.0.0.1:{PORT}/"

    errors: list[str] = []
    ok = True
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                        "--enable-unsafe-swiftshader"])
            ctx = b.new_context(viewport={"width": 2560, "height": 1440})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=20_000)
            time.sleep(2.0)          # first-frame jank: textures, shader compile
            ok = run(page)
            b.close()
    finally:
        if col:
            col.terminate()
            col.wait(timeout=10)

    print()
    passed = sum(1 for _, p_, _ in RESULTS if p_)
    print(f"summary: {passed}/{len(RESULTS)} cases passed")
    print("errors:", errors[:10] or "none")
    return 0 if (ok and not errors) else 1


if __name__ == "__main__":
    sys.exit(main())
