#!/usr/bin/env python3
"""Prove the TUNING PANEL against a real page.

`tuner.js` decides which rows exist and `settings_panel.js`'s two pure
helpers (`dirtyPatch`, `revertPatch`) decide what a Keep and a Revert
write; both are proved under `node --test`. Almost nothing else the panel
promises reaches there at all:

  * that the panel a person opens from the menu is really an element in the
    document rather than an object claiming `isOpen()` -- the exact split
    that got through a unit suite and a code review the same week for the
    menu itself;
  * that opening it NARROWS #stage and the canvas, and closing it restores
    both exactly -- it is a left rail, mirroring the right one, so that the
    globe is never drawn underneath it -- and that the relayout happens
    exactly once per toggle in each direction, which is how the right rail
    was verified;
  * that a drag reaches the wall through `preview` and stores nothing, so a
    reload is a free escape hatch;
  * that Keep writes the touched rows and ONLY the touched rows;
  * that Revert and Close both put the wall back;
  * and that the camera is held for the whole time the panel is open, then
    handed back on the MENU's short delay rather than the drag's long one.

Every one of those needs a real browser: `main.js` imports three, there is
no local `node_modules` in this repo, and the CSS layout, the localStorage
blob and the camera's own idle countdown are all properties of a running
page rather than of a module.

    python3 tools/verify_tuner.py
    python3 tools/verify_tuner.py --url http://HOST:8099/
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
# Its own port. verify_rules.py and verify_menu.py share 8499, verify_settings
# owns 8399 and verify_rules_editor owns 8599, so a fifth verifier reusing any
# of them would read as a flaky test rather than the resource conflict it is.
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8699"))

STORE_KEY = "netviz.settings.v1"

# The two rows this script drives, named by SCHEMA PATH rather than by row
# index or label text: the row order comes from tuner.js's GROUPS and a index
# written here would silently point at a different setting the first time a
# row is inserted above it.
BLOOM = "appearance.bloom.strength"      # number, 0 .. 2.0, ships at 0.7
OPACITY = "arcs.bodyOpacity"             # number, 0.04 .. 1.0, ships at 0.18
BLOOM_TARGET = 1.5
OPACITY_TARGET = 0.6

# Case 6's hand-back is timed against the rig's own rendered-time countdown
# (`rig.state.idleT`, summed from the render loop's dt) with a wall-clock cap
# on top. Under headless swiftshader with the synthetic feed competing for the
# main thread, dt accumulates at roughly a third of wall-clock speed -- the
# loop's `Math.min(0.1, now - last)` clamp discards the excess rather than
# catching up -- so `input.menuResumeSeconds` of 2 rendered seconds measured
# ~6s of wall clock in verify_menu.py's case 16. A wall-clock assertion sized
# off the nominal 2 would fail against working code.
HANDBACK_CAP_SECONDS = 30.0
HELD_SAMPLE_SECONDS = 20.0
# How far over `input.menuResumeSeconds` the measured hand-back may land, in
# RENDERED seconds. Generous: the countdown is sampled every 250ms of wall
# clock, so the reading overshoots by up to one poll's worth of rendered time,
# and the setting itself is small (2s). Wide enough not to be flaky, and still
# far under `input.resumeSeconds` (15) -- which is the value this factor exists
# to tell apart from the menu's.
HANDBACK_TOLERANCE = 2.0

# Case 7's viewport. 420 wide is the concrete failure the clamp exists for: an
# unclamped 380px slice leaves a 40px stage and a camera at aspect 0.055, and
# anything at or below 380 is a zero-width stage and a blank display.
SMALL_VIEWPORT = (420, 800)

RESULTS: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    RESULTS.append((name, ok, detail))
    return ok


def dispatch_contextmenu(page, x, y):
    """A real contextmenu Event, cancelable, on the canvas -- the same
    technique verify_menu.py and verify_rules_editor.py use rather than a
    Playwright button="right" click, so a right-click is driven identically
    everywhere in this repo."""
    return page.evaluate("""({x, y}) => {
      const canvas = document.querySelector('canvas');
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      });
      const notCanceled = canvas.dispatchEvent(ev);
      return !notCanceled;
    }""", {"x": x, "y": y})


def open_menu_and_click(page, data_id: str, cx: float, cy: float) -> bool:
    """Right-click the canvas, then click a `[data-id]` row. Callers assert on
    the visible effect, never on this return value alone: a click that lands is
    not proof the row is wired to anything."""
    dispatch_contextmenu(page, cx, cy)
    page.wait_for_timeout(200)
    return page.evaluate(
        """(id) => {
          const row = document.querySelector(`.menu [data-id="${id}"]`);
          if (!row || row.className.includes('disabled')) return false;
          row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
          return true;
        }""",
        data_id,
    )


def panel_state(page):
    """The ELEMENT's own answer, never `isOpen()`'s. `document.contains` plus a
    non-zero rect is the claim; an object reporting itself open while absent
    from the DOM is a bug this repo has already shipped once."""
    return page.evaluate("""() => {
      const el = document.querySelector('.tuner-panel');
      if (!el) return {present: false, apiOpen: !!window.__netviz.settingsPanel.isOpen()};
      const r = el.getBoundingClientRect();
      return {
        present: true, inDocument: document.contains(el),
        w: r.width, h: r.height, rows: el.querySelectorAll('.tuner-row').length,
        apiOpen: !!window.__netviz.settingsPanel.isOpen(),
      };
    }""")


def panel_is_really_open(state) -> bool:
    return bool(state.get("present") and state.get("inDocument")
                and state.get("w", 0) > 0 and state.get("h", 0) > 0)


def close_panel(page):
    page.evaluate("() => window.__netviz.settingsPanel.close()")
    page.wait_for_timeout(200)


def read_live(page, path):
    return page.evaluate("""async (p) => {
      const m = await import('./js/config.js');
      return m.cfg(p, null);
    }""", path)


def read_store(page):
    return page.evaluate("(k) => window.localStorage.getItem(k)", STORE_KEY)


def restore_store(page, original):
    """Put the display's stored patch back exactly as it was found.

    Case 4 clicks a real Keep, so it mutates real storage by design -- and with
    `--url` that storage belongs to a wall somebody configured, color rules
    included. A verifier has no business leaving a display altered, so the raw
    string is snapshotted before the run and written back after it, from a
    `finally` so a case that raises does not skip the restore.

    An absent key is restored by REMOVING it, never by writing `{}` or `null`:
    on this project an empty patch and no patch mean the same thing to every
    reader, and a stored `{}` reads as "this display was configured" when it
    was not."""
    return page.evaluate("""({k, original}) => {
      if (original === null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, original);
      return window.localStorage.getItem(k);
    }""", {"k": STORE_KEY, "original": original})


def drag_slider(page, path, value):
    """Drive the panel's OWN range input: set `.value`, dispatch a real `input`
    event, and let the panel's listener decide what happens.

    Deliberately not `settings.apply()`. Calling the applier directly proves
    the applier works, which is verify_settings.py's job -- it proves nothing
    at all about whether this panel is wired to it, which is this script's."""
    return page.evaluate("""async ({path, value}) => {
      const t = await import('./js/tuner.js');
      const idx = t.tunerRows().findIndex((r) => r.path === path);
      if (idx < 0) return {error: `tuner has no row for ${path}`};
      const rows = [...document.querySelectorAll('.tuner-row')];
      if (rows.length !== t.tunerRows().length) {
        return {error: `panel drew ${rows.length} rows, tuner.js declares ${t.tunerRows().length}`};
      }
      const row = rows[idx];
      const range = row.querySelector('.tuner-range');
      if (!range) return {error: `${path} is not a slider row`};
      range.value = String(value);
      range.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 60));
      const number = row.querySelector('.tuner-number');
      return {
        rangeValue: Number(range.value),
        numberValue: number ? Number(number.value) : null,
        dirtyClass: row.classList.contains('tuner-dirty'),
        count: (document.querySelector('.tuner-count') || {}).textContent,
        note: (document.querySelector('.tuner-note') || {}).textContent,
      };
    }""", {"path": path, "value": value})


def click_panel_button(page, cls) -> bool:
    return page.evaluate("""(cls) => {
      const b = document.querySelector(cls);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }""", cls)


# ------------------------------------------------------------------ cases --

def case1_panel_in_dom(page, cx, cy) -> bool:
    """1: the panel is really in the DOM, opened from the menu."""
    close_panel(page)
    clicked = open_menu_and_click(page, "settings", cx, cy)
    page.wait_for_timeout(300)
    state = panel_state(page)
    ok = clicked and panel_is_really_open(state)
    return report("1: the menu really puts the panel in the document", ok,
                  f"clicked={clicked} state={state}")


def case2_narrows_the_stage(page, cx, cy) -> bool:
    """2: opening the panel narrows #stage and the canvas; closing restores
    both, and each toggle costs exactly one relayout.

    The panel is a LEFT RAIL, not an overlay: the display must not cover the
    globe, so #stage gives up the panel's width and the globe is drawn beside
    it. The stage must move by exactly the panel's own width -- a stage that
    narrows by some other amount is a panel either overlapping the globe or
    floating over a gap -- and the drawing buffer must follow, or the globe
    renders at the full viewport's aspect inside a narrower box.

    `renderer.setSize` is counted, not merely observed to have happened. The
    right rail was verified the same way and for the same reason: a relayout
    rebuilds the composer's render targets, so two per toggle is a real cost
    and a silent one. Restoring is asserted BYTE-IDENTICAL against the
    pre-open numbers -- 'about the same' would pass a stage left one pixel
    narrow for the life of the page."""
    close_panel(page)
    page.wait_for_timeout(400)

    def measure():
        return page.evaluate("""() => {
          const c = window.__netviz.renderer.domElement;
          const s = document.querySelector('#stage').getBoundingClientRect();
          return {w: c.width, h: c.height,
                  stage: {x: s.x, y: s.y, w: s.width, h: s.height}};
        }""")

    # Count the relayouts by wrapping the real renderer's setSize for the
    # duration of the case, then putting the original back -- the rest of the
    # run must see an untouched renderer.
    page.evaluate("""() => {
      const r = window.__netviz.renderer;
      window.__tunerSetSize = {n: 0, orig: r.setSize.bind(r)};
      r.setSize = (...a) => { window.__tunerSetSize.n += 1;
                              return window.__tunerSetSize.orig(...a); };
    }""")
    calls = lambda: page.evaluate("() => window.__tunerSetSize.n")  # noqa: E731

    try:
        before = measure()
        n0 = calls()
        clicked = open_menu_and_click(page, "settings", cx, cy)
        page.wait_for_timeout(600)
        state = panel_state(page)
        opened = measure()
        n_open = calls() - n0

        panel_w = page.evaluate("""() => {
          const el = document.querySelector('.tuner-panel');
          return el ? el.getBoundingClientRect().width : null;
        }""")

        close_panel(page)
        page.wait_for_timeout(600)
        closed = measure()
        n_close = calls() - n0 - n_open
    finally:
        page.evaluate("""() => {
          if (window.__tunerSetSize) {
            window.__netviz.renderer.setSize = window.__tunerSetSize.orig;
            delete window.__tunerSetSize;
          }
        }""")

    narrowed_by = before["stage"]["w"] - opened["stage"]["w"]
    matches_panel = panel_w is not None and abs(narrowed_by - panel_w) < 1.0
    shifted = abs(opened["stage"]["x"] - (before["stage"]["x"] + panel_w)) < 1.0 \
        if panel_w is not None else False
    canvas_followed = opened["w"] < before["w"] and opened["h"] == before["h"]
    restored = closed == before
    ok = (clicked and panel_is_really_open(state) and matches_panel and shifted
          and canvas_followed and restored and n_open == 1 and n_close == 1)
    return report(
        "2: opening the panel narrows the stage, closing restores it, "
        "one relayout each way", ok,
        f"stage {before['stage']} -> {opened['stage']} -> {closed}; "
        f"canvas {before['w']}x{before['h']} -> {opened['w']}x{opened['h']} -> "
        f"{closed['w']}x{closed['h']}; panel width={panel_w} narrowed by "
        f"{narrowed_by} (matches={matches_panel}, left edge moved={shifted}); "
        f"setSize calls open={n_open} close={n_close}; restored exactly="
        f"{restored}; panelOpen={panel_is_really_open(state)}")


def case3_preview_stores_nothing(page) -> bool:
    """3: a drag changes the wall and stores nothing.

    Driven through the panel's own `<input type=range>` with a real `input`
    event. The two halves are one claim: the value must move on the wall
    (proving the row reaches `preview`) AND localStorage must be byte-identical
    (proving `preview` is the unwrapped applier, not the persisting one)."""
    state = panel_state(page)
    if not panel_is_really_open(state):
        return report("3: a drag moves the wall and stores nothing", False,
                      f"the panel is not open: {state}")
    store_before = read_store(page)
    live_before = read_live(page, BLOOM)
    out = drag_slider(page, BLOOM, BLOOM_TARGET)
    if out.get("error"):
        return report("3: a drag moves the wall and stores nothing", False, out["error"])
    live_after = read_live(page, BLOOM)
    store_after = read_store(page)
    ok = (live_before != live_after and abs((live_after or 0) - BLOOM_TARGET) < 1e-9
          and store_after == store_before and out["dirtyClass"])
    return report(
        "3: a drag moves the wall and stores nothing", ok,
        f"{BLOOM} {live_before} -> {live_after} (wanted {BLOOM_TARGET}), "
        f"row marked dirty={out['dirtyClass']}, footer={out['count']!r}, "
        f"localStorage unchanged={store_after == store_before} "
        f"(before={store_before!r})")


def case4_keep_writes_only_touched(page) -> bool:
    """4: Keep writes exactly the touched path, and nothing else.

    A DELTA on the key set, not an assertion that storage started empty: the
    keys afterward must equal the keys before plus exactly this one path. That
    is strictly stronger than 'the blob contains appearance.bloom.strength' --
    which a Keep persisting all 24 rows would satisfy, the exact failure the
    panel's dirty-tracking exists to prevent (24 values frozen at today's
    config.js numbers, after which the display silently stops tracking any
    later change to them) -- and it needs no empty start, so this script never
    has to clear a real display's settings to run."""
    raw_before = read_store(page)
    keys_before = set(json.loads(raw_before).keys()) if raw_before else set()
    clicked = click_panel_button(page, ".tuner-keep")
    page.wait_for_timeout(300)
    raw_after = read_store(page)
    stored = json.loads(raw_after) if raw_after else {}
    keys_after = set(stored.keys())
    want = keys_before | {BLOOM}
    value_ok = abs(stored.get(BLOOM, 0) - BLOOM_TARGET) < 1e-9
    still_dirty = page.evaluate(
        "() => document.querySelectorAll('.tuner-row.tuner-dirty').length")
    ok = clicked and keys_after == want and value_ok and still_dirty == 0
    return report(
        "4: Keep writes exactly the row that was touched", ok,
        f"clicked={clicked} stored keys {sorted(keys_before)} -> {sorted(keys_after)} "
        f"(wanted {sorted(want)}), {BLOOM}={stored.get(BLOOM)!r}, "
        f"rows still marked dirty={still_dirty}")


def case5_revert_and_close(page, cx, cy) -> bool:
    """5: Revert restores, and Close reverts too.

    Both, because either alone is passed by a bug: a Close that simply removed
    the node would pass the Revert half, and a Revert wired to Close's handler
    would pass the Close half. A different row from case 4's, so the
    re-baselining a Keep performs cannot be what makes this pass."""
    base = read_live(page, OPACITY)
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report("5: Revert restores, and Close reverts too", False, out["error"])
    moved = read_live(page, OPACITY)
    reverted_click = click_panel_button(page, ".tuner-revert")
    page.wait_for_timeout(300)
    after_revert = read_live(page, OPACITY)

    out2 = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out2.get("error"):
        return report("5: Revert restores, and Close reverts too", False, out2["error"])
    moved2 = read_live(page, OPACITY)
    closed_click = click_panel_button(page, ".tuner-close")
    page.wait_for_timeout(400)
    after_close = read_live(page, OPACITY)
    gone = page.evaluate("() => !document.querySelector('.tuner-panel')")

    ok = (reverted_click and closed_click and gone
          and abs(moved - OPACITY_TARGET) < 1e-9 and moved != base
          and abs(after_revert - base) < 1e-9
          and abs(moved2 - OPACITY_TARGET) < 1e-9
          and abs(after_close - base) < 1e-9)
    return report(
        "5: Revert restores, and Close reverts too", ok,
        f"{OPACITY} base={base}; drag -> {moved}, Revert -> {after_revert}; "
        f"drag -> {moved2}, Close -> {after_close}; panel removed={gone}")


def case6_camera_held(page, cx, cy) -> bool:
    """6: the camera is held for the whole time the panel is open, then handed
    back on the MENU's delay.

    Someone tuning bloom is watching the globe; the autonomous walk flying it
    somewhere else mid-drag, or a block burst yanking it away, breaks the
    measurement they are in the middle of making. `input.tick` re-pokes the rig
    every frame the panel is open, so `rig.manual()` must never go false while
    it is up.

    The hand-back is read from `rig.state.idleT` -- the countdown summed from
    the render loop's own dt -- rather than from a stopwatch. Under headless
    swiftshader with the synthetic feed running, simulated time accumulates at
    roughly a third of wall-clock speed, so `input.menuResumeSeconds` of 2
    rendered seconds is ~6s of wall clock; a wall-clock assertion sized off
    the nominal 2 would fail against working code. The wall figure is reported
    beside it for the reader."""
    close_panel(page)
    page.wait_for_timeout(500)
    clicked = open_menu_and_click(page, "settings", cx, cy)
    page.wait_for_timeout(400)
    state = panel_state(page)
    if not (clicked and panel_is_really_open(state)):
        return report("6: the camera is held while the panel is open", False,
                      f"could not open the panel: clicked={clicked} state={state}")

    samples = 0
    lost_at = None
    max_idle = 0.0
    t0 = time.time()
    while time.time() - t0 < HELD_SAMPLE_SECONDS:
        snap = page.evaluate("""() => ({
          manual: window.__netviz.rig.manual(),
          idleT: window.__netviz.rig.state.idleT,
          panel: !!document.querySelector('.tuner-panel'),
        })""")
        samples += 1
        max_idle = max(max_idle, snap["idleT"] or 0.0)
        if not snap["manual"] and lost_at is None:
            lost_at = time.time() - t0
            break
        if not snap["panel"]:
            lost_at = -1.0          # the panel vanished; the case is void
            break
        time.sleep(0.5)
    held_ok = lost_at is None and samples > 0

    # Close it and time the hand-back.
    click_panel_button(page, ".tuner-close")
    page.wait_for_timeout(100)
    t0 = time.time()
    freed_wall = None
    freed_rendered = None
    still_held_early = False
    last_idle = 0.0
    while time.time() - t0 < HANDBACK_CAP_SECONDS:
        snap = page.evaluate("""() => ({
          manual: window.__netviz.rig.manual(),
          idleT: window.__netviz.rig.state.idleT,
        })""")
        wall = time.time() - t0
        if snap["manual"]:
            last_idle = snap["idleT"] or last_idle
            if wall < 0.6:
                still_held_early = True   # not handed back the instant it closed
        else:
            freed_wall = wall
            freed_rendered = last_idle
            break
        time.sleep(0.25)

    # The delay is READ FROM THE PAGE, not hardcoded, and the RENDERED figure is
    # what is asserted. Printing `freed_rendered` while asserting only "released
    # before the wall-clock cap" makes the case blind to the failure it exists
    # for: at the ~3x headless slowdown anything up to ~10 rendered seconds
    # still lands inside a 30s cap, so a panel whose close fell through to the
    # ordinary drag delay (input.resumeSeconds, 15) would report success while
    # the wall handed itself back several times slower than it claims. The 15s
    # case does exceed the wall cap on THIS machine, which is worse than not
    # catching it: at a 2x slowdown it is 30s, exactly on the boundary, and a
    # verifier that passes or fails on how loaded the host happens to be is the
    # flaky shape this repo has been bitten by before.
    menu_resume = page.evaluate("""async () => {
      const m = await import('./js/config.js');
      return m.cfg('input.menuResumeSeconds', null);
    }""")
    budget = (menu_resume * HANDBACK_TOLERANCE) if menu_resume else None
    within = (freed_rendered is not None and budget is not None
              and freed_rendered <= budget)
    ok = held_ok and freed_wall is not None and still_held_early and within
    if freed_wall is None:
        # Two different failures, and the reader needs to know which: the camera
        # never came back at all, or it came back on a delay so much longer than
        # the menu's that it did not finish inside the cap -- the drag delay
        # falling through is exactly that, and is the likelier of the two.
        tail = (f"after close: not handed back within the {HANDBACK_CAP_SECONDS:.0f}s "
                f"wall-clock cap ({last_idle:.2f}s rendered elapsed by then) -- either "
                f"the camera was never released, or it is on a delay far longer than "
                f"menuResumeSeconds ({menu_resume}s)")
    else:
        tail = (f"after close: still held at <0.6s={still_held_early}, handed back "
                f"after {freed_rendered:.2f}s rendered ({freed_wall:.2f}s wall), "
                f"within {HANDBACK_TOLERANCE:g}x menuResumeSeconds "
                f"({menu_resume}s -> budget {budget}s rendered)={within}")
    return report(
        "6: the camera is held while the panel is open, handed back after", ok,
        f"{samples} samples over {HELD_SAMPLE_SECONDS:.0f}s with the panel open, "
        f"manual never dropped={held_ok} (lost_at={lost_at}, max idleT while open "
        f"{max_idle:.2f}s -- the per-frame pokes keep it near 0); {tail}")


def case7_small_viewport(page) -> bool:
    """7: on a small viewport the slice is clamped, and the stage stays usable.

    ITS OWN CASE, not folded into case 2, for one reason: it has to resize the
    viewport, and case 2's whole strength is a byte-exact comparison at the
    boot size. A case that changed the viewport underneath it would either
    pollute those numbers or need a restore whose failure mode is another
    case's silent flake. It runs last and puts the viewport back.

    The failure it exists for: the panel's width was pixels with nothing
    bounding it, so `body.tuner #stage { left: 380px }` took 380px of WHATEVER
    the viewport happened to be. At 420px wide the stage is 40px and the camera
    runs at aspect 0.055; at 380px or narrower the stage is zero-width and the
    display is blank until the panel is closed. The right rail cannot do this
    to itself because 26% is self-limiting. `--tuner-width: min(380px, 45vw)`
    is what bounds it, and because that one property feeds both the panel's
    `width` and the stage's `left`, the panel stays exactly as wide as the
    slice at every viewport -- which is what this case asserts, rather than
    asserting the clamp's arithmetic."""
    close_panel(page)
    page.wait_for_timeout(300)
    original = page.viewport_size
    page.set_viewport_size({"width": SMALL_VIEWPORT[0], "height": SMALL_VIEWPORT[1]})
    page.wait_for_timeout(600)

    def measure():
        return page.evaluate("""() => {
          const c = window.__netviz.renderer.domElement;
          const s = document.querySelector('#stage').getBoundingClientRect();
          const el = document.querySelector('.tuner-panel');
          return {
            canvas: {w: c.width, h: c.height},
            stage: {x: s.x, w: s.width, h: s.height},
            panel: el ? el.getBoundingClientRect().width : null,
            aspect: window.__netviz.camera.aspect,
            vw: window.innerWidth,
          };
        }""")

    try:
        before = measure()
        rect = page.evaluate("""() => {
          const r = document.querySelector('canvas').getBoundingClientRect();
          return {cx: r.left + r.width / 2, cy: r.top + r.height / 2};
        }""")
        clicked = open_menu_and_click(page, "settings", rect["cx"], rect["cy"])
        page.wait_for_timeout(600)
        state = panel_state(page)
        after = measure()
    finally:
        close_panel(page)
        if original:
            page.set_viewport_size(original)
        page.wait_for_timeout(600)

    panel_w = after["panel"]
    slice_w = before["stage"]["w"] - after["stage"]["w"]
    usable = (after["stage"]["w"] > 0 and after["canvas"]["w"] > 0
              and after["canvas"]["h"] > 0)
    # A finite, positive aspect is the difference between a squeezed globe and
    # a blank display: at stage width 0 this is 0 or NaN and nothing renders.
    aspect_ok = (isinstance(after["aspect"], (int, float))
                 and after["aspect"] == after["aspect"]   # not NaN
                 and after["aspect"] > 0)
    # The globe keeps the majority of a small viewport. This is the property
    # the clamp is FOR -- 45vw is one way to satisfy it, and the case must not
    # be a restatement of the number in the CSS.
    majority = after["stage"]["w"] > after["vw"] / 2
    # Panel and slice still agree, which is the single-source property case 2
    # proves at 2560 and this one re-proves under the clamp.
    matches = panel_w is not None and abs(slice_w - panel_w) < 1.0
    ok = (clicked and panel_is_really_open(state) and usable and aspect_ok
          and majority and matches)
    return report(
        f"7: at {SMALL_VIEWPORT[0]}x{SMALL_VIEWPORT[1]} the slice is clamped and "
        "the stage stays usable", ok,
        f"viewport {after['vw']}px: stage {before['stage']['w']} -> "
        f"{after['stage']['w']} (slice {slice_w}, panel {panel_w}, agree={matches}), "
        f"canvas {before['canvas']['w']}x{before['canvas']['h']} -> "
        f"{after['canvas']['w']}x{after['canvas']['h']}, camera aspect "
        f"{before['aspect']} -> {after['aspect']} (finite and positive={aspect_ok}), "
        f"stage keeps the majority={majority}, usable={usable}, "
        f"panelOpen={panel_is_really_open(state)}")


def run(page, cx, cy) -> bool:
    ok = True
    ok &= case1_panel_in_dom(page, cx, cy)
    ok &= case2_narrows_the_stage(page, cx, cy)
    # Case 2 now ends with the panel CLOSED -- restoring the stage is half of
    # what it proves -- so the cases after it open their own.
    open_menu_and_click(page, "settings", cx, cy)
    page.wait_for_timeout(400)
    ok &= case3_preview_stores_nothing(page)
    ok &= case4_keep_writes_only_touched(page)
    ok &= case5_revert_and_close(page, cx, cy)
    ok &= case6_camera_held(page, cx, cy)
    # Last, because it resizes the viewport. It restores it, but a case that
    # moves the ground under the others is one that should have as little
    # after it as possible.
    ok &= case7_small_viewport(page)
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
            ctx = b.new_context(viewport={"width": 2560, "height": 1440})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=20_000)
            time.sleep(2.0)          # first-frame jank: textures, shader compile

            rect = page.evaluate("""() => {
              const r = document.querySelector('canvas').getBoundingClientRect();
              return {cx: r.left + r.width / 2, cy: r.top + r.height / 2};
            }""")
            # Case 4 clicks a real Keep, so this run WILL write to the display's
            # own stored patch. With --url that display is a wall somebody
            # configured, so the blob is snapshotted here and written back in
            # the `finally` below -- never cleared, and never left changed.
            original_store = read_store(page)
            try:
                ok = run(page, rect["cx"], rect["cy"])
            finally:
                final_store = restore_store(page, original_store)
                same = final_store == original_store
                print(f"stored patch restored: {same} "
                      f"(key {'absent' if original_store is None else 'present'} "
                      f"before, {'absent' if final_store is None else 'present'} after)")
                if not same:
                    errors.append("localStorage was not restored to its original value")
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
