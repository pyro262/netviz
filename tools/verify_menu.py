#!/usr/bin/env python3
"""Prove the kiosk menu's gestures against a real browser.

Gestures are the half of Task 3 that cannot be judged by reading. This
script drives a real Chromium (or a real deployment, with --url) through
the nine cases the menu's three openers, its refusal to open on a plain
mouse double-click, and its interaction with the camera rig and the
settings layer must satisfy.

Every case that claims the menu is OPEN asserts the menu ELEMENT is
actually in the document with a non-zero bounding rect -- not just that
`__netviz.menu.isOpen()` says so. That distinction is exactly the bug
that got through a unit suite and a code review this week: a menu that
reported itself open while being absent from the DOM, because the
test's DOM fake allowed a `dataset` write that a real HTMLElement
forbids.

Touch taps are dispatched as PointerEvent objects from inside the page
(pointerType 'touch'), with the inter-tap gap timed by an in-page
setTimeout rather than by the Python process. Two things forced that
choice, both measured:

- A plain `new PointerEvent('pointerdown', ...)` dispatched from JS hits
  a real Chromium behaviour: `canvas.setPointerCapture(id)`, which
  onDown calls on every pointerdown, throws "no active pointer with the
  given id is found" for a synthetic pointer that never went through the
  real input pipeline. The harness patches `setPointerCapture` /
  `releasePointerCapture` on the canvas to swallow that one exception
  before dispatching -- a test-only patch on the live DOM object, not a
  change to any shipped file. The events themselves still reach the
  same `addEventListener('pointerdown', ...)` the app registered and are
  handled identically in every other respect.
- CDP's `Input.dispatchTouchEvent` was tried first and does NOT need the
  patch (it goes through Chromium's real touch pipeline), but under this
  headless swiftshader setup with a live synthetic feed pushing frames,
  each CDP round trip measured 0.5-1.7s even in a mostly-idle page --
  enough on its own to blow the 320ms double-tap window regardless of
  the intended gap. An in-page setTimeout avoids the IPC hop entirely
  and lands close to its nominal delay.

A short settle after `__netvizReady` is still needed before any
timing-sensitive gesture: immediately after load, first-frame jank
(texture decode, shader compile) can stretch a 180ms real gap much
further.

    python3 tools/verify_menu.py
    python3 tools/verify_menu.py --url http://HOST:8099/
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
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8499"))

RESULTS: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    RESULTS.append((name, ok, detail))
    return ok


def menu_state(page):
    """Menu ELEMENT presence + visibility, not just the API's own claim."""
    return page.evaluate("""() => {
      const el = document.querySelector('.menu');
      const api = window.__netviz.menu.isOpen();
      if (!el) return {present: false, api};
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
      return {present: true, api, visible, w: r.width, h: r.height,
              inDocument: document.contains(el)};
    }""")


def great_circle_deg(a, b) -> float:
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    d = (math.sin(lat1) * math.sin(lat2)
         + math.cos(lat1) * math.cos(lat2) * math.cos(lon1 - lon2))
    d = max(-1.0, min(1.0, d))
    return math.degrees(math.acos(d))


def dispatch_contextmenu(page, x, y):
    """A real contextmenu Event, cancelable, on the canvas -- not a call
    into the handler. Returns whether preventDefault() was called."""
    return page.evaluate("""({x, y}) => {
      const canvas = document.querySelector('canvas');
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      });
      const notCanceled = canvas.dispatchEvent(ev);
      return !notCanceled;
    }""", {"x": x, "y": y})


def install_touch_patch(page):
    """Patch setPointerCapture/releasePointerCapture on the canvas to
    swallow Chromium's "no active pointer" exception for a JS-dispatched
    PointerEvent. Test-harness-only: it lives on the live DOM object in
    the page under test, never in any shipped file, and does not change
    what listeners receive or how they behave otherwise."""
    page.evaluate("""() => {
      const canvas = document.querySelector('canvas');
      if (canvas.__patchedCapture) return;
      for (const m of ['setPointerCapture', 'releasePointerCapture']) {
        const orig = canvas[m].bind(canvas);
        canvas[m] = (id) => { try { orig(id); } catch (e) { /* synthetic pointer */ } };
      }
      canvas.__patchedCapture = true;
    }""")


def js_tap_pair(page, x1, y1, x2, y2, gap_ms, moved=None):
    """Two touch tap gestures (pointerdown+pointerup, pointerType
    'touch') at (x1,y1) and (x2,y2), separated by gap_ms timed with an
    in-page setTimeout -- immune to Python/CDP round-trip latency, which
    measured 0.5-1.7s per call in this environment and made a
    Python-timed gap useless for anything under the 320ms double-tap
    window. `moved`, if given, is (dx, dy) applied as a pointermove
    before each tap's pointerup -- the "tap that moved" case."""
    page.evaluate("""async ({x1, y1, x2, y2, gapMs, moved}) => {
      const canvas = document.querySelector('canvas');
      let id = Math.floor(Math.random() * 100000) + 1000;
      function fire(type, x, y) {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: id, pointerType: 'touch', isPrimary: true,
        }));
      }
      function oneTap(x, y) {
        id += 1;
        fire('pointerdown', x, y);
        if (moved) fire('pointermove', x + moved[0], y + moved[1]);
        fire('pointerup', moved ? x + moved[0] : x, moved ? y + moved[1] : y);
      }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      oneTap(x1, y1);
      await sleep(gapMs);
      oneTap(x2, y2);
    }""", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "gapMs": gap_ms, "moved": moved})


def run(page, canvas_center) -> bool:
    cx, cy = canvas_center
    ok = True
    install_touch_patch(page)

    def close_menu():
        page.evaluate("() => window.__netviz.menu.close()")
        time.sleep(0.1)

    # ---------------------------------------------------------- case 1 --
    close_menu()
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    ok &= report(
        "1: right-click opens the menu",
        prevented and st["present"] and st.get("inDocument") and st.get("visible"),
        f"defaultPrevented={prevented} state={st}")
    close_menu()

    # ---------------------------------------------------------- case 2 --
    page.mouse.click(cx, cy)
    time.sleep(0.06)
    page.mouse.click(cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    ok &= report(
        "2: mouse double-click does nothing",
        not st["present"],
        f"state={st}")

    # ---------------------------------------------------------- case 3 --
    js_tap_pair(page, cx, cy, cx, cy, 180)
    time.sleep(0.3)
    st = menu_state(page)
    ok &= report(
        "3: touch double-tap opens the menu",
        st["present"] and st.get("inDocument") and st.get("visible"),
        f"state={st}")
    close_menu()

    # ---------------------------------------------------------- case 4 --
    js_tap_pair(page, cx, cy, cx, cy, 700)
    time.sleep(0.3)
    st = menu_state(page)
    ok &= report(
        "4: two slow taps (700ms) do not open it",
        not st["present"],
        f"state={st}")
    close_menu()

    # ---------------------------------------------------------- case 5 --
    js_tap_pair(page, cx, cy, cx, cy, 180, moved=(120, 0))
    time.sleep(0.3)
    st = menu_state(page)
    ok &= report(
        "5: a tap that moved does not open it",
        not st["present"],
        f"state={st}")
    close_menu()

    # ---------------------------------------------------------- case 6 --
    fs_before = page.evaluate("() => document.fullscreenElement !== null")
    page.keyboard.press("s")
    time.sleep(0.2)
    st_open = menu_state(page)
    page.keyboard.press("s")
    time.sleep(0.2)
    st_closed_by_key = menu_state(page)

    page.keyboard.press("s")   # reopen, to test click-away
    time.sleep(0.2)
    st_reopen = menu_state(page)
    # click well away from the menu, on the canvas itself
    page.evaluate("""() => {
      const ev = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 5, clientY: 5, pointerId: 999,
      });
      document.body.dispatchEvent(ev);
    }""")
    time.sleep(0.2)
    st_closed_by_click = menu_state(page)
    fs_after = page.evaluate("() => document.fullscreenElement !== null")
    ok &= report(
        "6: 's' toggles and a click away closes; fullscreen untouched",
        st_open["present"] and st_open.get("visible")
        and not st_closed_by_key["present"]
        and st_reopen["present"] and st_reopen.get("visible")
        and not st_closed_by_click["present"]
        and fs_before == fs_after,
        f"open={st_open} closedByKey={st_closed_by_key['present']} "
        f"reopen={st_reopen['present']} closedByClick={st_closed_by_click['present']} "
        f"fs_before={fs_before} fs_after={fs_after}")
    close_menu()

    # ---------------------------------------------------------- case 7 --
    before = page.evaluate("""() => {
      const c = window.__netviz.renderer.domElement;
      return {w: c.width, rail: document.body.classList.contains('rail')};
    }""")
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    row_ok = False
    if st["present"]:
        row_ok = page.evaluate("""() => {
          const row = document.querySelector('.menu [data-id="rail"]');
          if (!row) return false;
          row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
          return true;
        }""")
    time.sleep(0.6)
    after = page.evaluate("""() => {
      const c = window.__netviz.renderer.domElement;
      return {w: c.width, rail: document.body.classList.contains('rail')};
    }""")
    ok &= report(
        "7: rail toggle end to end (body.rail + drawing buffer to 1894)",
        prevented and st["present"] and st.get("visible") and row_ok
        and not before["rail"] and after["rail"] and after["w"] == 1894,
        f"before={before} after={after} row_ok={row_ok}")
    # restore: rail off again, close the menu the click already closed
    page.evaluate("() => window.__netviz.settings.apply({'rail.enabled': false})")
    time.sleep(0.4)
    close_menu()

    # ---------------------------------------------------------- case 8 --
    page.evaluate("() => window.__netviz.settings.apply({'input.lock': true})")
    time.sleep(0.1)
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    ok &= report(
        "8: input.lock refuses the menu, native menu still suppressed",
        prevented and not st["present"],
        f"defaultPrevented={prevented} state={st}")
    page.evaluate("() => window.__netviz.settings.apply({'input.lock': false})")
    time.sleep(0.1)

    # ---------------------------------------------------------- case 9 --
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    opened = prevented and st["present"] and st.get("visible")
    print(f"      case 9 setup: menu open={opened}, sampling rig.view() "
          f"over 35s (input.resumeSeconds=30)...")
    samples = []
    manual_flags = []
    t_start = time.time()
    # 8 samples spanning 35s: dense enough to catch a drift, sparse enough
    # that the polling itself isn't what keeps the rig "poked". The interval
    # divides by (n_samples - 1), not n_samples -- 8 samples have 7 GAPS
    # between them, and dividing by the sample count under-delivers the
    # promised span by one interval's worth (measured: 30.6s instead of 35s
    # in an earlier version of this script, barely past resumeSeconds=30,
    # the exact threshold this case exists to outlast). The elapsed time is
    # asserted below, not just printed, so a regression here fails loudly
    # instead of silently shipping a shorter run.
    n_samples = 8
    interval = 35.0 / (n_samples - 1)
    for i in range(n_samples):
        snap = page.evaluate("""() => ({
          view: window.__netviz.rig.view(),
          manual: window.__netviz.rig.manual(),
          menuOpen: window.__netviz.menu.isOpen(),
        })""")
        samples.append(snap["view"])
        manual_flags.append(snap["manual"])
        elapsed = time.time() - t_start
        print(f"      t={elapsed:5.1f}s view={snap['view']} manual={snap['manual']} "
              f"menuOpen={snap['menuOpen']}")
        if i < n_samples - 1:
            time.sleep(interval)
    total_elapsed = time.time() - t_start
    max_drift = max(great_circle_deg(samples[0], s) for s in samples)
    ok &= report(
        "9: camera stays manual and still while the menu is open (35s)",
        opened and all(manual_flags) and max_drift < 1.0 and total_elapsed >= 35.0,
        f"opened={opened} all_manual={all(manual_flags)} "
        f"max_drift_deg={max_drift:.4f} elapsed={total_elapsed:.1f}s")
    close_menu()

    return ok


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
            ctx = b.new_context(viewport={"width": 2560, "height": 1440}, has_touch=True)
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=20_000)
            # Let first-frame jank settle: immediately after ready, main-thread
            # work can stretch a real 180ms gap between two taps considerably,
            # which would make case 3 flaky.
            time.sleep(2.0)

            rect = page.evaluate("""() => {
              const r = document.querySelector('canvas').getBoundingClientRect();
              return {cx: r.left + r.width / 2, cy: r.top + r.height / 2};
            }""")

            ok = run(page, (rect["cx"], rect["cy"]))
            b.close()
    finally:
        if col:
            col.terminate()
            col.wait(timeout=10)

    print()
    passed = sum(1 for _, p, _ in RESULTS if p)
    print(f"summary: {passed}/{len(RESULTS)} cases passed")
    print("errors:", errors[:10] or "none")

    return 0 if (ok and not errors) else 1


if __name__ == "__main__":
    sys.exit(main())
