#!/usr/bin/env python3
"""Prove the kiosk menu's gestures against a real browser.

Gestures are the half of Task 3 that cannot be judged by reading. This
script drives a real Chromium (or a real deployment, with --url) through
15 cases: the menu's three openers, its refusal to open on a plain mouse
double-click, its interaction with the camera rig and the settings layer,
four cases added after a whole-branch review found real bugs a spy
assertion had let through -- "Look here" silently doing nothing (case 10),
the native context menu still appearing over an open menu (case 11), the
rail toggle disagreeing with what is on screen once `?rail=1` was removed
in favour of a stored setting (case 12), and the corner-clamp layout path
(case 13) -- and one more
(case 14) added after a SCOPED RE-REVIEW of the case 10 fix found it had
introduced a regression: a block burst could now steal a view someone was
holding, because the fix's hand-back lived in the one method both the
menu and the automatic burst detector called. Case 15 covers a defect a
screenshot found and no unit test could: `#stage` is `position: fixed`,
which creates a stacking context, so a menu mounted inside it was painted
UNDER the `#rail` sibling and read as transparent.

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


def dispatch_contextmenu_on_menu(page):
    """A contextmenu Event dispatched on the `.menu` element ITSELF, not the
    canvas -- proves the listener also covers a right-click on the menu
    (and, by the same fix, the rail / degraded banner / update mark, none
    of them children of the canvas). Returns None if no menu
    is present, else whether preventDefault() was called."""
    return page.evaluate("""() => {
      const el = document.querySelector('.menu');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      });
      const notCanceled = el.dispatchEvent(ev);
      return !notCanceled;
    }""")


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


def run_rail_toggle_case(ctx, url) -> bool:
    """Case 12, on its own page: the menu's rail toggle agrees with what is
    on screen, from storage.

    The old form of this case loaded `?rail=1`. The parameter is gone: the
    rail is a stored setting, so this seeds storage exactly as a person
    clicking the toggle would have, reloads, and checks the menu agrees."""
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
            if m.type == "error" else None)
    try:
        page.goto(url, wait_until="load")
        page.wait_for_function("window.__netvizReady === true", timeout=20_000)
        page.evaluate("""() => {
          window.localStorage.setItem('netviz.settings.v1',
            JSON.stringify({'rail.enabled': true}));
        }""")
        page.reload(wait_until="load")
        page.wait_for_function("window.__netvizReady === true", timeout=20_000)
        time.sleep(2.0)
        install_touch_patch(page)

        rail_on_boot = page.evaluate("() => document.body.classList.contains('rail')")
        rect = page.evaluate("""() => {
          const r = document.querySelector('canvas').getBoundingClientRect();
          return {cx: r.left + r.width / 2, cy: r.top + r.height / 2};
        }""")
        prevented = dispatch_contextmenu(page, rect["cx"], rect["cy"])
        time.sleep(0.2)
        rail_row_on = page.evaluate("""() => {
          const row = document.querySelector('.menu [data-id="rail"]');
          if (!row) return null;
          const check = row.querySelector('.menu-check');
          return check ? check.classList.contains('on') : null;
        }""")
        page.evaluate("""() => {
          const row = document.querySelector('.menu [data-id="rail"]');
          row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        }""")
        time.sleep(0.6)
        rail_after_click = page.evaluate("() => document.body.classList.contains('rail')")
        page.evaluate("() => window.localStorage.removeItem('netviz.settings.v1')")

        ok = report(
            "12: the rail toggle agrees with the stored setting",
            prevented and rail_on_boot and rail_row_on is True
            and not rail_after_click and not errors,
            f"rail_on_boot={rail_on_boot} rail_row_on={rail_row_on} "
            f"rail_after_click={rail_after_click} errors={errors[:5] or 'none'}")
        return ok
    finally:
        page.close()


def run_menu_over_rail_case(ctx, url) -> bool:
    """Case 15, on its own page with the rail seeded through storage: the
    menu must be the topmost thing where it overlaps the rail.

    `#stage` is `position: fixed`, and a fixed element creates a STACKING
    CONTEXT -- so a `.menu` mounted under it ranks its `z-index: 5` only
    among `#stage`'s own children, while `#rail` is a later sibling of
    `#stage` at the root level and paints over the entire stage subtree.
    The menu's opaque background was drawn correctly and the rail's numbers
    were simply painted on top of it, which reads as a transparent menu.
    Raising the menu's z-index cannot fix it (measured: 9999 changes
    nothing); the menu has to leave `#stage`.

    Hit-testing is the check, not a screenshot: `elementsFromPoint` returns
    the paint order the eye sees, and a pixel comparison of amber-on-near-
    black would need a threshold nobody can defend."""
    page = ctx.new_page()
    try:
        page.goto(url, wait_until="load")
        page.wait_for_function("window.__netvizReady === true", timeout=20_000)
        page.evaluate("""() => {
          window.localStorage.setItem('netviz.settings.v1',
            JSON.stringify({'rail.enabled': true}));
        }""")
        page.reload(wait_until="load")
        page.wait_for_function("window.__netvizReady === true", timeout=20_000)
        time.sleep(2.0)
        # The rail is the right 26%; open the menu just inside its left edge
        # so the panel is guaranteed to overlap it.
        pos = page.evaluate("""() => {
          const r = document.getElementById('rail').getBoundingClientRect();
          return {x: r.left + 8, y: r.top + r.height * 0.25};
        }""")
        prevented = dispatch_contextmenu(page, pos["x"], pos["y"])
        time.sleep(0.2)
        probe = page.evaluate("""() => {
          const el = document.querySelector('.menu');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const railRect = document.getElementById('rail').getBoundingClientRect();
          const overlaps = r.right > railRect.left;
          // A point well inside the menu, and inside the rail's column.
          const px = Math.max(r.left + 12, railRect.left + 4);
          const py = r.top + Math.min(40, r.height / 2);
          const top = document.elementsFromPoint(px, py)
                              .map((e) => (e.className || e.id || e.tagName).toString());
          return {overlaps, point: [px, py], top: top.slice(0, 3),
                  menuIsTopmost: !!(top.length && el.contains(document.elementFromPoint(px, py))),
                  parent: el.parentElement.id || el.parentElement.tagName};
        }""")
        ok = report(
            "15: the menu paints over the rail, not under it",
            bool(probe) and prevented and probe["overlaps"] and probe["menuIsTopmost"],
            f"probe={probe}")
        page.evaluate("() => window.localStorage.removeItem('netviz.settings.v1')")
        return ok
    finally:
        page.close()


def run(page, canvas_center, ctx, url) -> bool:
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

    # --------------------------------------------------------- case 10 --
    # "Look here" must actually move the camera. The bug this catches: every
    # menu opener leaves rig.manual() true (toggleMenu pokes on open,
    # input.tick re-pokes every frame the menu stays open), which used to be
    # exactly the ONE state startVisit() refuses to interrupt by default --
    # so the menu closed and the camera never moved, silently, every time.
    # A spy assertion (menu.test.mjs's own lookHere test) only proves
    # rig.visit() was CALLED, not that it did anything; this polls the real
    # rig.view() until it settles and checks it actually arrived.
    close_menu()
    before_view = page.evaluate("() => window.__netviz.rig.view()")
    # NDC (0.15, 0.1), not dead centre: pointAt({x:0,y:0}) always equals the
    # camera's OWN current lat/lon (the camera looks at the origin every
    # frame), which would make "arrived" trivially true whether visit() did
    # anything or not -- an early version of this case had exactly that bug,
    # caught by dist_deg reading 0.0 before the click even fired. This NDC
    # stays inside the globe's disc (angular radius 12.56 deg vs the 17.5 deg
    # vertical half-FOV, i.e. NDC ~0.718) while landing somewhere the camera
    # was not already looking, so a non-trivial `initial_gap` proves the case
    # tests something.
    offset_ndc = {"x": 0.15, "y": 0.1}
    look_target = page.evaluate("(ndc) => window.__netviz.rig.pointAt(ndc)", offset_ndc)
    initial_gap = great_circle_deg(before_view, look_target) if look_target else None
    click_pt = page.evaluate("""(ndc) => {
      const r = document.querySelector('canvas').getBoundingClientRect();
      return {x: r.left + (ndc.x + 1) / 2 * r.width, y: r.top + (1 - ndc.y) / 2 * r.height};
    }""", offset_ndc)
    prevented = dispatch_contextmenu(page, click_pt["x"], click_pt["y"])
    time.sleep(0.2)
    st = menu_state(page)
    row_ok = False
    if st["present"]:
        row_ok = page.evaluate("""() => {
          const row = document.querySelector('.menu [data-id="lookHere"]');
          if (!row || row.className.includes('disabled')) return false;
          row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
          return true;
        }""")
    # Poll on the STATE MACHINE'S OWN arrival signal (phase leaving 'visit'),
    # not a distance guess against a fixed timeout. Measured: under this
    # headless/swiftshader setup with a live synthetic feed competing for the
    # main thread, `dt` accumulates at roughly 1/3 of wall-clock speed (the
    # animation loop's own `Math.min(0.1, now - last)` clamp means a slow
    # frame loses ground rather than catching up), so the SIMULATED time
    # startVisit's own arriveDegrees=3 check runs against lags well behind
    # real time. A fixed 20s wall-clock timeout against a ~19deg offset
    # measured arrival at 28.6s in isolation, and slower still alongside the
    # rest of this suite -- so this polls for up to 90s of real time, which
    # is generous even accounting for that slowdown, and stops the moment
    # the app itself declares arrival rather than when a re-derived distance
    # threshold happens to agree with it.
    arrived = False
    last_view = None
    last_phase = None
    t0 = time.time()
    while time.time() - t0 < 90.0:
        snap = page.evaluate(
            "() => ({view: window.__netviz.rig.view(), phase: window.__netviz.rig.state.phase})")
        last_view = snap["view"]
        last_phase = snap["phase"]
        if last_phase != "visit":
            arrived = True
            break
        time.sleep(1.0)
    dist = great_circle_deg(look_target, last_view) if look_target and last_view else None
    ok &= report(
        "10: 'Look here' actually moves the camera to the clicked point",
        prevented and st["present"] and row_ok and look_target is not None
        and initial_gap is not None and initial_gap > 5.0 and arrived
        and dist is not None and dist < 5.0,
        f"before={before_view} target={look_target} initial_gap_deg={initial_gap} "
        f"final_view={last_view} final_phase={last_phase} dist_deg={dist} row_ok={row_ok} "
        f"elapsed={time.time() - t0:.1f}s")
    close_menu()

    # --------------------------------------------------------- case 11 --
    # The native context menu must be suppressed on a right-click landing
    # ON the open menu itself, not just on the canvas -- `.menu` is a child
    # of #stage, not of the canvas, so a canvas-only listener let Chrome's
    # own Back/Reload/Save-as through over an open menu.
    close_menu()
    dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    st = menu_state(page)
    prevented_on_menu = dispatch_contextmenu_on_menu(page) if st["present"] else None
    ok &= report(
        "11: right-click on the OPEN MENU itself is still suppressed",
        st["present"] and prevented_on_menu is True,
        f"state={st} preventedOnMenu={prevented_on_menu}")
    close_menu()

    # --------------------------------------------------------- case 12 --
    # Own page, own seeded storage -- see run_rail_toggle_case's docstring.
    ok &= run_rail_toggle_case(ctx, url)

    # --------------------------------------------------------- case 13 --
    # clampPosition's real offsetWidth/offsetHeight path is exercised by
    # nothing else in either suite -- node --test's DOM fake returns 0 for
    # both, which only reaches the nominal-size fallback branch.
    close_menu()
    dispatch_contextmenu(page, 5, 5)   # top-left corner
    time.sleep(0.2)
    rect = page.evaluate("""() => {
      const el = document.querySelector('.menu');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {left: r.left, top: r.top, right: r.right, bottom: r.bottom,
              vw: window.innerWidth, vh: window.innerHeight};
    }""")
    inside = bool(rect) and (rect["left"] >= 0 and rect["top"] >= 0
                              and rect["right"] <= rect["vw"] and rect["bottom"] <= rect["vh"])
    ok &= report(
        "13: menu opened near a corner stays fully inside the viewport",
        inside,
        f"rect={rect}")
    close_menu()

    # --------------------------------------------------------- case 14 --
    # A block burst must NOT steal a held view. Regression case for a bug a
    # scoped re-review caught in the case 10 fix: camera.js's visit() used
    # to unconditionally hand the camera back before starting a visit, which
    # fixed "Look here" but also meant the automatic burst detour (main.js,
    # calling this exact rig.visit()) could now fly away from underneath
    # someone mid-drag -- exactly what CLAUDE.md documents as a guarantee
    # ("a block burst never takes a held view, and a burst during a drag is
    # dropped rather than queued"). camera.js's fix split the method in two:
    # visit() (the burst detector's path, unconditionally respecting the
    # manual/held guard) and lookHere() (the menu's path, which overrides
    # it). This drives the REAL page through a REAL drag -- unlike
    # campath.test.mjs's existing burst-vs-manual tests, which call
    # startVisit() directly on raw state and so never exercised camera.js's
    # visit()/lookHere() wrapper at all, the exact gap that let the
    # regression through. camera.js cannot be imported under `node --test`
    # in this repo (no local `three` package, no node_modules, no bundler --
    # confirmed: `node --input-type=module --eval "import('camera.js')"`
    # fails with "Cannot find package 'three'"), so this is the only place
    # that can prove the wrapper itself, not just the state machine under it.
    close_menu()
    before_view = page.evaluate("() => window.__netviz.rig.view()")
    burst_target = {
        "lat": max(-60.0, min(60.0, -before_view["lat"])),
        "lon": ((before_view["lon"] + 150 + 180) % 360) - 180,
    }
    page.mouse.move(cx, cy)
    page.mouse.down()   # real pointerdown -> rig.grab(): manual=true, held=true
    time.sleep(0.1)
    mid_drag = page.evaluate(
        "() => ({manual: window.__netviz.rig.manual(), held: window.__netviz.rig.held()})")
    visit_result = page.evaluate(
        "(t) => window.__netviz.rig.visit(t.lat, t.lon)", burst_target)
    time.sleep(0.3)
    after_view = page.evaluate("() => window.__netviz.rig.view()")
    after_state = page.evaluate(
        "() => ({manual: window.__netviz.rig.manual(), held: window.__netviz.rig.held()})")
    page.mouse.up()     # real pointerup -> rig.release(), clean up the drag
    time.sleep(0.1)
    view_unchanged = (abs(after_view["lat"] - before_view["lat"]) < 0.01
                       and abs(after_view["lon"] - before_view["lon"]) < 0.01)
    ok &= report(
        "14: a block burst (rig.visit) does not steal a view being held",
        mid_drag["manual"] and mid_drag["held"] and visit_result is False
        and view_unchanged and after_state["manual"] and after_state["held"],
        f"before={before_view} burst_target={burst_target} mid_drag={mid_drag} "
        f"visit_result={visit_result} after={after_view} after_state={after_state}")

    # --------------------------------------------------------- case 16 --
    # Closing the menu hands the camera back on the MENU's countdown
    # (input.menuResumeSeconds, 2s), not the drag's (input.resumeSeconds, 15s).
    # Case 9 proves the camera stays put while the menu is open; this proves it
    # does not stay put afterwards, which is the half a user actually notices --
    # before this, opening the menu froze the wall for the full drag delay.
    #
    # Timed against the RIG's own manual flag rather than a wall clock, and
    # given a generous cap: the countdown is summed from the render loop's dt,
    # which under headless swiftshader with the synthetic feed runs ~3x behind
    # real time (see case 10's note), so 2s of rendered time can be ~6s here.
    # A wall-clock assertion sized off the nominal 2s would fail against
    # working code.
    close_menu()
    time.sleep(3.0)                       # let any earlier claim expire
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    opened = prevented and menu_state(page)["present"]
    close_menu()
    t0 = time.time()
    still_manual_at = None
    freed_at = None
    while time.time() - t0 < 30.0:
        snap = page.evaluate("() => ({manual: window.__netviz.rig.manual(), "
                             "menuOpen: window.__netviz.menu.isOpen()})")
        dt = time.time() - t0
        if dt < 0.6 and snap["manual"]:
            still_manual_at = dt      # not handed back instantly on close
        if not snap["manual"]:
            freed_at = dt
            break
        time.sleep(0.25)
    ok &= report(
        "16: the walk resumes shortly after the menu closes",
        opened and freed_at is not None and still_manual_at is not None,
        f"opened={opened} still manual at {still_manual_at}s after close, "
        f"handed back after {freed_at}s "
        f"(menuResumeSeconds=2 in rendered time; 30s wall cap)")

    # --------------------------------------------------------- case 17 --
    # Closing the menu with a LEFT CLICK OUTSIDE it hands back on the menu's
    # countdown too -- not the drag's.
    #
    # Case 16 closes the menu through menu.close(), which no press is involved
    # in, so it never exercised the path a person actually uses. Clicking away
    # is how a menu gets dismissed, and that press used to do two things: the
    # menu's document-level capture listener closed the menu, and then the
    # canvas's bubble-phase listener treated the SAME press as a grab. A grab
    # is a drag's own claim (campath.beginManual clears resumeAfter), so the
    # 2s menu hand-back silently became the 15s drag one and the wall sat
    # parked. Reported from the wall, not caught by any test.
    #
    # The press is aimed well away from the menu, which opens at the canvas
    # centre: 40px from the top-left corner is outside it at any size the
    # clamp allows. Timed against the rig's own flag with a generous cap, for
    # the rendered-vs-wall-clock reason case 16 records.
    close_menu()
    time.sleep(3.0)                       # let any earlier claim expire
    prevented = dispatch_contextmenu(page, cx, cy)
    time.sleep(0.2)
    opened17 = prevented and menu_state(page)["present"]
    page.mouse.click(40, 40)              # a real press, outside the menu
    time.sleep(0.2)
    closed17 = not menu_state(page)["present"]
    t0 = time.time()
    still_manual17 = None
    freed17 = None
    while time.time() - t0 < 30.0:
        snap = page.evaluate("() => window.__netviz.rig.manual()")
        dt = time.time() - t0
        if dt < 0.6 and snap:
            still_manual17 = dt
        if not snap:
            freed17 = dt
            break
        time.sleep(0.25)
    ok &= report(
        "17: clicking away from the menu hands back on the menu's delay",
        opened17 and closed17 and freed17 is not None and freed17 < 20.0,
        f"opened={opened17} closed={closed17} still manual at "
        f"{still_manual17}s, handed back after {freed17}s "
        f"(menu 2s vs drag 15s, both in rendered time; 30s wall cap)")

    # --------------------------------------------------------- case 15 --
    # Own page again, because it needs the rail actually mounted.
    ok &= run_menu_over_rail_case(ctx, url)

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

            ok = run(page, (rect["cx"], rect["cy"]), ctx, url)
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
