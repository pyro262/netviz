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
  * that all three of Keep, Revert and Close ASK FIRST when something is
    pending, through the one confirm.js dialog the page already has, and
    that answering Cancel leaves the panel open with the change still
    pending and still unstored -- the dialog is the only thing standing
    between a stray click and work nobody wrote down;
  * that the menu's mutual exclusion between the two panels goes through
    `requestClose()` rather than the force-close, so picking "Custom arcs..."
    over unkept changes asks instead of discarding them silently, and a
    Cancel leaves the rules panel shut and the changes pending;
  * that the rows whose value is baked into an arc's geometry SAY SO, and
    that dragging one really does clear the arcs and let them come back --
    unannounced, every arc vanishing under your hand reads as the feed dying;
  * that Randomize rolls the rows that change what the display LOOKS like --
    `tuner.js`'s per-row `randomize` flag, 29 of the 38 sliders -- inside
    their own schema bounds, leaves the camera pacing and the star ramp
    untouched, marks each row it moves dirty exactly as a drag does, asks
    nothing, and is undone by one Revert;
  * that every clickable control lights under the pointer and a DISABLED one
    does not -- a disabled button that lifts is a control lying about being
    clickable, and the guard that stops it is a computed style no unit test
    in this repo can see;
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

# Case 13's pair. A FLOW row both times: the synthetic feed draws flows tens of
# times a second, so a cleared pool visibly refills within seconds, where
# `arcs.block.*` would make the case wait on a block arriving and measure the
# feed's luck instead of the panel.
REBUILD_ROW = "arcs.flow.tube"           # rebuild: clears the pool
REBUILD_TARGET = 0.006                   # inside 0.001 .. 0.02
CONTROL_ROW = "arcs.flow.gain"           # uniform: must NOT clear the pool
CONTROL_TARGET = 0.9                     # inside 0.05 .. 3
# How long a cleared pool may take to draw its first arc again. Generous: under
# headless swiftshader the render loop is the bottleneck, and the point is that
# the arcs come back at all rather than how fast.
REFILL_CAP_SECONDS = 15.0

# Case 7's hand-back is timed against the rig's own rendered-time countdown
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

# Case 10's viewport. 420 wide is the concrete failure the clamp exists for: an
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
    """The API close, which does NOT ask. The Close BUTTON confirms when
    something is pending; the returned close() is how the menu, this script and
    anything else closes the panel on the display's behalf, and there is nobody
    in front of it to answer a question. Cases that mean to exercise the
    dialog click `.tuner-close` instead."""
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
    """Put this RUN's stored patch back exactly as it was found.

    It was written here, and claimed during development, that with `--url` the
    storage case 4 writes to belongs to a wall somebody configured -- that the
    release gate was overwriting an operator's color rules. That was measured
    and it is FALSE, and never was true: Playwright's `new_context()` gives
    each run its own ephemeral profile, so the origin store this script reads
    and writes has never been a real display's. The tell was in plain sight and
    was read past -- every local run started from an empty store, which is what
    per-context isolation looks like.

    The restore stays, for two reasons that survive the correction. It is
    defense for the day anyone swaps in `launch_persistent_context()`, where
    that isolation disappears with nothing announcing it. And case 4 asserts a
    DELTA -- the keys present before, plus exactly the one path a Keep touched
    -- which is a stronger assertion than clear-then-assert-empty, needs no
    empty start, and is the one that survives if the isolation ever goes.
    The raw string is snapshotted before the run and written back after it,
    from a `finally` so a case that raises does not skip the restore.

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


def confirm_state(page):
    """The confirm dialog's own ELEMENT, on the same terms panel_state() reads
    the panel: present in the document with a non-zero rect, never an object
    claiming it is open. It also reports whether a Yes button exists at all --
    confirm.js drops it when `will` is empty, so its presence is the difference
    between a question and an acknowledgement."""
    return page.evaluate("""() => {
      const el = document.querySelector('.confirm');
      if (!el) return {present: false};
      const r = el.getBoundingClientRect();
      return {
        present: true, inDocument: document.contains(el),
        w: r.width, h: r.height,
        yes: !!el.querySelector('.confirm-yes'),
        no: !!el.querySelector('.confirm-no'),
        title: (el.querySelector('.confirm-title') || {}).textContent || '',
        text: el.textContent || '',
      };
    }""")


def confirm_is_really_open(state) -> bool:
    return bool(state.get("present") and state.get("inDocument")
                and state.get("w", 0) > 0 and state.get("h", 0) > 0)


def answer_confirm(page, yes: bool) -> bool:
    """Click Yes or Cancel on whatever dialog is up. Returns False when there
    was no dialog to answer -- which every caller asserts on, because a
    confirmation that silently failed to appear would otherwise read as one
    that was answered."""
    ok = page.evaluate("""(yes) => {
      const el = document.querySelector('.confirm');
      if (!el) return false;
      const b = el.querySelector(yes ? '.confirm-yes' : '.confirm-no');
      if (!b) return false;
      b.click();
      return true;
    }""", yes)
    page.wait_for_timeout(250)
    return bool(ok)


def click_and_confirm(page, cls, yes: bool = True):
    """Click one of the panel's three buttons and answer the dialog it raises.

    Every one of Keep, Revert and Close now asks first when something is
    pending, so a case that clicks and then reads the wall would measure the
    state BEFORE the question was answered. Returns (clicked, dialog_seen,
    answered) so a case can tell "the button was dead" from "the button ran
    without asking" -- the second is the regression this whole change is."""
    clicked = click_panel_button(page, cls)
    page.wait_for_timeout(250)
    state = confirm_state(page)
    seen = confirm_is_really_open(state)
    answered = answer_confirm(page, yes) if seen else False
    page.wait_for_timeout(250)
    return clicked, seen, answered, state


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
    which a Keep persisting all 39 rows would satisfy, the exact failure the
    panel's dirty-tracking exists to prevent (39 values frozen at today's
    config.js numbers, after which the display silently stops tracking any
    later change to them) -- and it needs no empty start, so this script never
    has to clear a real display's settings to run.

    Keep now ASKS FIRST, and the dialog is asserted rather than merely clicked
    through: a Keep that wrote without asking would still pass the delta, so
    `dialog` is part of the verdict. The question is also checked to name the
    row -- in words, from settingLabel -- because a confirmation that says
    "your changes" is one nobody can act on."""
    raw_before = read_store(page)
    keys_before = set(json.loads(raw_before).keys()) if raw_before else set()
    clicked, dialog, answered, cstate = click_and_confirm(page, ".tuner-keep")
    names_row = "bloom strength" in (cstate.get("text") or "").lower()
    page.wait_for_timeout(300)
    raw_after = read_store(page)
    stored = json.loads(raw_after) if raw_after else {}
    keys_after = set(stored.keys())
    want = keys_before | {BLOOM}
    value_ok = abs(stored.get(BLOOM, 0) - BLOOM_TARGET) < 1e-9
    still_dirty = page.evaluate(
        "() => document.querySelectorAll('.tuner-row.tuner-dirty').length")
    ok = (clicked and dialog and answered and names_row
          and keys_after == want and value_ok and still_dirty == 0)
    return report(
        "4: Keep asks first, then writes exactly the row that was touched", ok,
        f"clicked={clicked} asked={dialog} answered={answered} "
        f"question={cstate.get('title')!r} names the row in words={names_row}; "
        f"stored keys {sorted(keys_before)} -> {sorted(keys_after)} "
        f"(wanted {sorted(want)}), {BLOOM}={stored.get(BLOOM)!r}, "
        f"rows still marked dirty={still_dirty}")


def case5_revert_and_close(page, cx, cy) -> bool:
    """5: Revert restores, and Close reverts too.

    Both, because either alone is passed by a bug: a Close that simply removed
    the node would pass the Revert half, and a Revert wired to Close's handler
    would pass the Close half. A different row from case 4's, so the
    re-baselining a Keep performs cannot be what makes this pass.

    It also asserts the STORE did not move. Neither Revert nor Close is a write
    -- the whole point of the preview applier is that nothing is remembered
    until Keep -- but reading only the live value would pass a Revert or a
    Close that quietly wrote to localStorage on the way past, and the restore
    in main()'s `finally` would then erase the evidence before anyone looked."""
    base = read_live(page, OPACITY)
    store_base = read_store(page)
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report("5: Revert restores, and Close reverts too", False, out["error"])
    moved = read_live(page, OPACITY)
    # Both of these ask first now, and both dialogs are asserted: a Revert or a
    # Close that put the wall back WITHOUT asking would otherwise pass this
    # case unchanged, which is precisely the regression to catch.
    reverted_click, revert_dialog, revert_answered, _ = \
        click_and_confirm(page, ".tuner-revert")
    page.wait_for_timeout(300)
    after_revert = read_live(page, OPACITY)

    out2 = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out2.get("error"):
        return report("5: Revert restores, and Close reverts too", False, out2["error"])
    moved2 = read_live(page, OPACITY)
    closed_click, close_dialog, close_answered, _ = \
        click_and_confirm(page, ".tuner-close")
    page.wait_for_timeout(400)
    after_close = read_live(page, OPACITY)
    gone = page.evaluate("() => !document.querySelector('.tuner-panel')")
    store_after = read_store(page)
    store_same = store_after == store_base

    ok = (reverted_click and closed_click and gone
          and revert_dialog and revert_answered
          and close_dialog and close_answered
          and abs(moved - OPACITY_TARGET) < 1e-9 and moved != base
          and abs(after_revert - base) < 1e-9
          and abs(moved2 - OPACITY_TARGET) < 1e-9
          and abs(after_close - base) < 1e-9
          and store_same)
    return report(
        "5: Revert restores, and Close reverts too, each asking first", ok,
        f"{OPACITY} base={base}; drag -> {moved}, Revert (asked={revert_dialog}, "
        f"answered={revert_answered}) -> {after_revert}; drag -> {moved2}, "
        f"Close (asked={close_dialog}, answered={close_answered}) -> {after_close}; "
        f"panel removed={gone}; localStorage unchanged={store_same}")


def case6_cancel_is_safe(page, cx, cy) -> bool:
    """6: the dialog is real, and Cancel changes nothing.

    Cancel is the default answer in confirm.js precisely so a stray second
    click destroys nothing, and this is the case that proves the tuning panel
    actually gets that: after canceling a Close, the panel must still be open,
    the change must still be pending on the wall, the row must still be marked,
    and nothing must have reached localStorage. A dialog whose Cancel closed
    the panel anyway -- or whose Yes was wired to both buttons -- would pass
    case 5 unchanged, because case 5 only ever answers yes.

    Then it answers yes and asserts the close really happened, so this case
    cannot pass against a Close button that does nothing at all."""
    close_panel(page)
    page.wait_for_timeout(300)
    clicked = open_menu_and_click(page, "settings", cx, cy)
    page.wait_for_timeout(400)
    if not panel_is_really_open(panel_state(page)):
        return report("6: the close question is real, and Cancel is safe", False,
                      f"could not open the panel: clicked={clicked}")

    base = read_live(page, OPACITY)
    store_base = read_store(page)
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report("6: the close question is real, and Cancel is safe", False,
                      out["error"])
    moved = read_live(page, OPACITY)

    click_panel_button(page, ".tuner-close")
    page.wait_for_timeout(300)
    asked = confirm_state(page)
    asked_ok = confirm_is_really_open(asked) and asked.get("yes") and asked.get("no")
    # It is a QUESTION, not an acknowledgement: `will` is populated, so
    # confirm.js draws a Yes. And it names the pending row in words.
    names_row = "body opacity" in (asked.get("text") or "").lower()

    canceled = answer_confirm(page, False)
    page.wait_for_timeout(400)
    after_cancel = {
        "panel": panel_is_really_open(panel_state(page)),
        "dialog": confirm_is_really_open(confirm_state(page)),
        "live": read_live(page, OPACITY),
        "dirty": page.evaluate(
            "() => document.querySelectorAll('.tuner-row.tuner-dirty').length"),
        "store": read_store(page),
    }
    safe = (after_cancel["panel"] and not after_cancel["dialog"]
            and abs((after_cancel["live"] or 0) - OPACITY_TARGET) < 1e-9
            and after_cancel["dirty"] >= 1
            and after_cancel["store"] == store_base)

    # And now through it for real.
    clicked2, dialog2, answered2, _ = click_and_confirm(page, ".tuner-close")
    page.wait_for_timeout(400)
    gone = page.evaluate("() => !document.querySelector('.tuner-panel')")
    after_close = read_live(page, OPACITY)
    store_after = read_store(page)
    confirmed_ok = (clicked2 and dialog2 and answered2 and gone
                    and abs(after_close - base) < 1e-9
                    and store_after == store_base)

    ok = (asked_ok and names_row and canceled and safe and confirmed_ok
          and abs(moved - OPACITY_TARGET) < 1e-9 and moved != base)
    return report(
        "6: the close question is real, and Cancel is safe", ok,
        f"{OPACITY} base={base} -> drag {moved}; Close asked={asked_ok} "
        f"(title={asked.get('title')!r}, names the row={names_row}); after Cancel: "
        f"panel open={after_cancel['panel']}, dialog gone="
        f"{not after_cancel['dialog']}, live still {after_cancel['live']}, rows "
        f"marked dirty={after_cancel['dirty']}, store unchanged="
        f"{after_cancel['store'] == store_base} (safe={safe}); then confirmed: "
        f"asked={dialog2} panel removed={gone} live -> {after_close}, store "
        f"unchanged={store_after == store_base}")


def case7_camera_held(page, cx, cy) -> bool:
    """7: the camera is held for the whole time the panel is open, then handed
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
        return report("7: the camera is held while the panel is open", False,
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
        "7: the camera is held while the panel is open, handed back after", ok,
        f"{samples} samples over {HELD_SAMPLE_SECONDS:.0f}s with the panel open, "
        f"manual never dropped={held_ok} (lost_at={lost_at}, max idleT while open "
        f"{max_idle:.2f}s -- the per-frame pokes keep it near 0); {tail}")


def case10_hover(page, cx, cy) -> bool:
    """10: a clickable button changes under the pointer, and a DISABLED one
    does not.

    The disabled half is the whole point and is the easy one to regress: Keep
    and Revert are disabled with nothing pending, and a disabled button that
    lights up is a control lying about being clickable. Dropping the
    `:not(:disabled)` guard from the CSS is a one-character mistake that no
    unit test in this repo can see, because it is a computed style on a real
    element under a real pointer.

    Both directions are asserted in one case on purpose. "The disabled button
    did not change" is also what a hover rule that does not exist at all looks
    like, so it is only evidence when the enabled button, hovered the same way
    on the same page, does change."""
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("10: hover lifts a clickable button and never a disabled "
                      "one", False, "could not open the panel")
    page.wait_for_timeout(400)

    def bg(sel):
        return page.evaluate("""(sel) => {
          const b = document.querySelector(sel);
          if (!b) return null;
          const cs = getComputedStyle(b);
          return {bg: cs.backgroundColor, border: cs.borderTopColor,
                  cursor: cs.cursor, disabled: !!b.disabled};
        }""", sel)

    # Nothing pending yet, so Keep is disabled. Move the pointer well away
    # first: a hover left over from the click that opened the panel would make
    # the "resting" reading a hovered one.
    page.mouse.move(cx, cy)
    page.wait_for_timeout(150)
    keep_rest = bg(".tuner-keep")
    page.hover(".tuner-keep")
    page.wait_for_timeout(200)
    keep_hover = bg(".tuner-keep")
    disabled_ok = (keep_rest and keep_rest["disabled"]
                   and keep_hover["bg"] == keep_rest["bg"]
                   and keep_hover["border"] == keep_rest["border"]
                   # ...and it does not claim to be clickable either.
                   and keep_hover["cursor"] != "pointer")

    # Randomize is never disabled, so it is the control that proves the rule
    # exists at all -- read at rest first, from a pointer parked elsewhere.
    page.mouse.move(cx, cy)
    page.wait_for_timeout(150)
    rnd_rest = bg(".tuner-randomize")
    page.hover(".tuner-randomize")
    page.wait_for_timeout(200)
    rnd_hover = bg(".tuner-randomize")
    enabled_ok = (rnd_rest and not rnd_rest["disabled"]
                  and rnd_hover["bg"] != rnd_rest["bg"]
                  and rnd_hover["cursor"] == "pointer")

    # Now make something pending so Keep ENABLES, and hover the same button
    # again: same element, same gesture, opposite answer.
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report("10: hover lifts a clickable button and never a disabled "
                      "one", False, out["error"])
    page.mouse.move(cx, cy)
    page.wait_for_timeout(150)
    keep_rest2 = bg(".tuner-keep")
    page.hover(".tuner-keep")
    page.wait_for_timeout(200)
    keep_hover2 = bg(".tuner-keep")
    enabled_keep_ok = (keep_rest2 and not keep_rest2["disabled"]
                       and keep_hover2["bg"] != keep_rest2["bg"]
                       and keep_hover2["cursor"] == "pointer")

    close_panel(page)
    page.wait_for_timeout(300)

    ok = disabled_ok and enabled_ok and enabled_keep_ok
    return report(
        "10: hover lifts a clickable button and never a disabled one", ok,
        f"Keep disabled: {keep_rest['bg']} -> {keep_hover['bg']} "
        f"(unchanged={keep_hover['bg'] == keep_rest['bg']}, cursor="
        f"{keep_hover['cursor']}); Randomize enabled: {rnd_rest['bg']} -> "
        f"{rnd_hover['bg']} (changed={rnd_hover['bg'] != rnd_rest['bg']}); Keep "
        f"once enabled: {keep_rest2['bg']} -> {keep_hover2['bg']} "
        f"(changed={keep_hover2['bg'] != keep_rest2['bg']})")


def case11_small_viewport(page) -> bool:
    """11: on a small viewport the slice is clamped, the stage stays usable,
    and the header stays reachable however far the panel is scrolled.

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
    asserting the clamp's arithmetic.

    The scroll half was added with the arc-shape group. At 39 rows the panel
    scrolls at every viewport this display is ever on -- 1975px of content at
    380px wide, 3636px at the clamped 189px -- so the four buttons are only
    reachable because `.tuner-sticky` pins them. This case scrolls the panel to
    the very bottom and asserts every one of them is still inside it, which is
    the same "a control past the fold does not exist" test that moved them out
    of a footer, applied to the direction that broke next. It runs at 420x800,
    where the panel is at its most cramped and the content at its longest."""
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
            // Every header button's rect against the panel's own, because at
            // this width the actions group is wider than the content box: the
            // group is 228.5px and the panel is 189px. `.tuner-head`'s
            // flex-wrap does not save it -- that drops the group as a UNIT,
            // which does nothing once the group alone does not fit -- and
            // `.tuner-panel` sets `overflow-y: auto`, so `overflow-x` computes
            // to auto and Close simply scrolls off the right edge. A control
            // that is off the panel is a control that does not exist, which is
            // the same failure that moved these three buttons out of the
            // footer in the first place.
            buttons: el ? [...el.querySelectorAll('.tuner-actions button')].map((b) => {
              const r = b.getBoundingClientRect(), p = el.getBoundingClientRect();
              return {
                label: b.textContent, right: r.right, bottom: r.bottom,
                inside: r.right <= p.right + 0.5 && r.left >= p.left - 0.5
                        && r.width > 0 && r.height > 0,
              };
            }) : [],
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
        # Scroll to the very bottom and measure the buttons again. `measure()`
        # already reports each one's rect against the panel's; what changes is
        # that the rows above them have gone, so a header in the ordinary flow
        # has gone with them.
        scrolled = page.evaluate("""() => {
          const el = document.querySelector('.tuner-panel');
          el.scrollTop = el.scrollHeight;
          return {top: el.scrollTop, scrollH: el.scrollHeight,
                  clientH: el.clientHeight};
        }""")
        page.wait_for_timeout(200)
        after_scroll = measure()
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
    # Every header button horizontally inside the panel. `.tuner-actions` wraps
    # for this: at 420px the group cannot fit on one line, so it has to break
    # into rows rather than push Close off the edge behind a scrollbar.
    outside = [b["label"] for b in after["buttons"] if not b["inside"]]
    buttons_ok = len(after["buttons"]) == 4 and not outside
    # The panel really is scrolling -- otherwise "the buttons survived a
    # scroll" is a claim about a scroll that never happened -- and every button
    # is still inside the panel's box at the bottom of it.
    panel_scrolls = scrolled["scrollH"] > scrolled["clientH"] + 1 and scrolled["top"] > 0
    off_after_scroll = [b["label"] for b in after_scroll["buttons"]
                        if not b["inside"] or b["bottom"] <= 0]
    sticky_ok = (panel_scrolls and len(after_scroll["buttons"]) == 4
                 and not off_after_scroll)
    ok = (clicked and panel_is_really_open(state) and usable and aspect_ok
          and majority and matches and buttons_ok and sticky_ok)
    return report(
        f"11: at {SMALL_VIEWPORT[0]}x{SMALL_VIEWPORT[1]} the slice is clamped and "
        "the stage stays usable", ok,
        f"viewport {after['vw']}px: stage {before['stage']['w']} -> "
        f"{after['stage']['w']} (slice {slice_w}, panel {panel_w}, agree={matches}), "
        f"canvas {before['canvas']['w']}x{before['canvas']['h']} -> "
        f"{after['canvas']['w']}x{after['canvas']['h']}, camera aspect "
        f"{before['aspect']} -> {after['aspect']} (finite and positive={aspect_ok}), "
        f"stage keeps the majority={majority}, usable={usable}, "
        f"{len(after['buttons'])} header buttons, off the panel={outside or 'none'}, "
        f"panelOpen={panel_is_really_open(state)}; scrolled to "
        f"{scrolled['top']}/{scrolled['scrollH']} (client {scrolled['clientH']}, "
        f"really scrolls={panel_scrolls}): buttons still reachable="
        f"{not off_after_scroll} (off={off_after_scroll or 'none'})")


def custom_arcs_panel_open(page) -> bool:
    """The custom-arcs panel's own element, on the same terms as the tuning
    panel's: in the document with a non-zero rect."""
    return bool(page.evaluate("""() => {
      const el = document.querySelector('.custom-arc-panel');
      if (!el || !document.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }"""))


def case8_menu_mutual_exclusion(page, cx, cy) -> bool:
    """8: opening "Custom arcs..." over pending changes ASKS, and a Cancel
    leaves everything where it was.

    menu.js enforces mutual exclusion between the two panels by closing this
    one before opening the other. While that call was the force-close, an
    operator with unkept changes who picked "Custom arcs..." had them discarded
    SILENTLY -- the exact case the Close question exists for, reached by a door
    that skipped it. So the menu goes through `requestClose(onClosed)` now, and
    both halves are asserted here because either alone is passed by a bug: a
    Cancel that opened the rules panel anyway is worse than the silent discard
    it replaced, and a confirm that never actually closed anything would leave
    the menu's one job undone.

    It drives `arcs.bodyOpacity`, NOT the row case 4 Kept: after a Keep the
    kept row's live value IS its baseline, so a drag to the same target moves
    nothing and this case would assert against a change that never happened.

    The wall value, the dirty mark AND the store are all read after the Cancel:
    "still pending" means the preview is still on the globe and still written
    down nowhere."""
    close_panel(page)
    page.wait_for_timeout(250)
    page.evaluate("() => window.__netviz.customArcsPanel && window.__netviz.customArcsPanel.close()")
    page.wait_for_timeout(200)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("8: the menu asks before dropping pending changes for the "
                      "rules panel", False, "could not open the tuning panel")
    page.wait_for_timeout(400)

    base = read_live(page, OPACITY)
    store_base = read_store(page)
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report("8: the menu asks before dropping pending changes for the "
                      "rules panel", False, out["error"])
    moved = read_live(page, OPACITY)

    # Cancel first.
    clicked = open_menu_and_click(page, "customArcs", cx, cy)
    page.wait_for_timeout(300)
    asked = confirm_state(page)
    asked_ok = confirm_is_really_open(asked) and asked.get("yes") and asked.get("no")
    canceled = answer_confirm(page, False)
    page.wait_for_timeout(400)
    after_cancel = {
        "rules": custom_arcs_panel_open(page),
        "tuner": panel_is_really_open(panel_state(page)),
        "live": read_live(page, OPACITY),
        "dirty": page.evaluate(
            "() => document.querySelectorAll('.tuner-row.tuner-dirty').length"),
        "store": read_store(page),
    }
    safe = (clicked and asked_ok and canceled
            and not after_cancel["rules"] and after_cancel["tuner"]
            and abs((after_cancel["live"] or 0) - OPACITY_TARGET) < 1e-9
            and after_cancel["dirty"] >= 1
            and after_cancel["store"] == store_base)

    # Then through it for real.
    clicked2 = open_menu_and_click(page, "customArcs", cx, cy)
    page.wait_for_timeout(300)
    asked2 = confirm_is_really_open(confirm_state(page))
    answered2 = answer_confirm(page, True) if asked2 else False
    page.wait_for_timeout(500)
    after = {
        "rules": custom_arcs_panel_open(page),
        "tuner": panel_is_really_open(panel_state(page)),
        "live": read_live(page, OPACITY),
        "store": read_store(page),
    }
    through = (clicked2 and asked2 and answered2
               and after["rules"] and not after["tuner"]
               and abs((after["live"] or 0) - base) < 1e-9
               and after["store"] == store_base)

    page.evaluate("() => window.__netviz.customArcsPanel && window.__netviz.customArcsPanel.close()")
    page.wait_for_timeout(200)

    ok = safe and through and abs(moved - OPACITY_TARGET) < 1e-9 and moved != base
    return report(
        "8: the menu asks before dropping pending changes for the rules panel", ok,
        f"{OPACITY} base={base} -> drag {moved}; Custom arcs asked={asked_ok}; after "
        f"Cancel: rules panel open={after_cancel['rules']} (must be False), tuning "
        f"panel open={after_cancel['tuner']}, live still {after_cancel['live']}, rows "
        f"marked dirty={after_cancel['dirty']}, store unchanged="
        f"{after_cancel['store'] == store_base} (safe={safe}); then confirmed: "
        f"asked={asked2} tuner gone={not after['tuner']} rules open={after['rules']} "
        f"live -> {after['live']} store unchanged={after['store'] == store_base}")


def case9_randomize(page, cx, cy) -> bool:
    """9: Randomize moves the LOOK rows and only those, inside the bounds, with
    no dialog -- and one Revert puts the whole lot back.

    `randomizeValue` is proved against the real catalogue under `node --test`;
    what only a page can show is that the BUTTON is wired to it, that every row
    it touches is marked dirty exactly as a drag's is, that it does NOT ask
    (Keep, Revert and Close all do, and a dialog in front of the quick button is
    what would teach people to click through the other three), and that the
    values that land on the wall are the ones the applier accepted.

    THE EXCLUDED ROWS ARE THE HALF THAT MATTERS. Asserting only that the 29
    moved passes unchanged against a regression that quietly randomizes all 38
    again -- the exact behavior this rule removed. The two sets are read from
    `tuner.js`'s own `randomize` flag rather than listed here, so the case
    follows the judgement rather than duplicating it, and `tuner.test.mjs` is
    what holds the flag to the nine paths by name.

    The bounds are read from tuner.js itself too, so a schema change moves the
    assertion with the control."""
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("9: Randomize rolls the look rows and leaves the pacing "
                      "alone", False, "could not open the panel")
    page.wait_for_timeout(400)

    store_base = read_store(page)
    before = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const c = await import('./js/config.js');
      const out = {};
      for (const r of t.tunerRows()) out[r.path] = c.cfg(r.path, null);
      return out;
    }""")
    clicked = click_panel_button(page, ".tuner-randomize")
    page.wait_for_timeout(500)
    dialog = confirm_is_really_open(confirm_state(page))
    if dialog:
        answer_confirm(page, False)
    after = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const c = await import('./js/config.js');
      const rows = t.tunerRows();
      const vals = {}, bounds = {};
      for (const r of rows) {
        vals[r.path] = c.cfg(r.path, null);
        if (r.control === 'slider') bounds[r.path] = {min: r.min, max: r.max, step: r.step};
      }
      return {
        vals, bounds,
        // The two sets, as the page itself reports them.
        look: rows.filter((r) => r.control === 'slider' && r.randomize).map((r) => r.path),
        held: rows.filter((r) => r.control === 'slider' && !r.randomize).map((r) => r.path),
        dirty: document.querySelectorAll('.tuner-row.tuner-dirty').length,
        count: (document.querySelector('.tuner-count') || {}).textContent,
        note: (document.querySelector('.tuner-note') || {}).textContent,
      };
    }""")

    look, held = after["look"], after["held"]
    inside = [p for p, b in after["bounds"].items()
              if not (b["min"] - 1e-9 <= after["vals"][p] <= b["max"] + 1e-9)]
    # NON-SLIDERS MAY MOVE NOW, and exactly which ones is the assertion.
    #
    # Until 0.7.0 this read "every non-slider must be untouched", on the ground
    # that the one color row on the panel -- `appearance.background` -- has a
    # luminance cap that REFUSES rather than clamps, so a randomizer aimed at it
    # would spend half its rolls being rejected and read as a broken button.
    # That is still true of the sky, and the sky is still excluded.
    #
    # What changed is that the panel absorbed the theme, so Randomize now rolls
    # the twenty catalogue colors and the surface tints as well -- through
    # `randomizePatch`, whose whole design is that every value is valid BY
    # CONSTRUCTION rather than by rolling and hoping. So the check is no longer
    # "nothing else moved" but "nothing moved that the roller does not declare",
    # read from `RANDOMIZE_PATHS` itself rather than listed here.
    declared = page.evaluate(
        "async () => (await import('./js/randomize_color.js')).RANDOMIZE_PATHS")
    others = [p for p in before
              if p not in after["bounds"] and after["vals"][p] != before[p]
              and p not in declared]
    # The sky specifically: it is the one path that refuses rather than clamps,
    # and it must still be out of scope however much else came in.
    sky_moved = "appearance.background" in declared
    moved = sum(1 for p in look if after["vals"][p] != before[p])
    # The half that catches a regression back to randomizing everything.
    strayed = [p for p in held if after["vals"][p] != before[p]]

    reverted_click, revert_dialog, revert_answered, _ = \
        click_and_confirm(page, ".tuner-revert")
    page.wait_for_timeout(400)
    back = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const c = await import('./js/config.js');
      const out = {};
      for (const r of t.tunerRows()) out[r.path] = c.cfg(r.path, null);
      return out;
    }""")
    restored = [p for p in before if back[p] != before[p]]
    store_after = read_store(page)

    ok = (clicked and not dialog and not inside and not others and not strayed
          # A randomize that moved one row and left 16 alone is not a
          # randomize. Not `== len(look)`: a roll can legitimately land a row
          # back on the value it already held.
          #
          # THESE TWO NUMBERS ARE A TRIPWIRE AND MUST BE UPDATED WHENEVER THE
          # PANEL GAINS OR LOSES A ROW. They are hardcoded on purpose -- derived
          # from the same schema the panel is built from, they would agree with
          # a panel that had silently lost half its rows. That is also why they
          # go stale: 29/9 was correct until the clouds layer added three look
          # sliders (32) and lightning added four more (36), and the clouds
          # commit updated tests/js/tuner.test.mjs without updating this. The
          # symptom is this case failing while every behavioural signal on its
          # own report line is correct, which is what happened on 2026-08-15
          # and AGAIN on 2026-08-18: the numbers were still 36/9 while the
          # panel had grown to 41/9 across the theme work, and the Milky Way
          # band's four rows then took it to 44/10. Moving the two built-in
          # arc colors out to the color-rules panel took it to 42/10, and
          # 0.7.0's five rail text scales take it to 47/10.
          and not sky_moved
          and len(look) == 47 and len(held) == 10
          and moved >= len(look) - 2
          # Bounded on BOTH sides -- a panel that dirtied every row fails here
          # as well. The upper bound is the look sliders PLUS the declared
          # color paths that have a row on this panel, because 0.7.0's
          # Randomize rolls those too and each one marks its row.
          and len(look) - 2 <= after["dirty"] <= len(look) + len(
              [p for p in declared if p in before])
          and reverted_click and revert_dialog and revert_answered
          and not restored and store_after == store_base)
    return report(
        "9: Randomize rolls the look rows and leaves the pacing alone", ok,
        f"clicked={clicked} asked={dialog} (must be False); {moved}/{len(look)} look "
        f"sliders moved, {len(held)} excluded rows moved={strayed or 'none'}, "
        f"{after['dirty']} rows marked dirty, out of bounds={inside}, "
        f"undeclared non-sliders touched={others} (sky in scope={sky_moved}, "
        f"must be False), note={after['note']!r}; after Revert "
        f"(asked={revert_dialog}): rows still changed={restored}, store unchanged="
        f"{store_after == store_base}")


def case12_randomize_scope_is_stated(page, cx, cy) -> bool:
    """12: the panel SAYS what Randomize touches, and the marks agree with it.

    Case 9 proves the behavior -- 29 look rows roll, 9 held rows do not. This
    one proves the display admits to it, which is a separate claim: the scope
    lived only in the button's `title` until now, and a wall display is not
    hovered. Same call the color-rules MATCH legend made in 0.4.5.

    THE SECOND ASSERTION IS THE ONE WORTH HAVING. Text on a panel is a claim
    about behavior, and a claim with nothing holding it to the code goes stale
    the first time a row is added -- which is exactly what is about to happen to
    this panel. So the marked rows are compared to the rows Randomize ACTUALLY
    dirties, row by row and by index rather than by count: a mark on the wrong
    row keeps the total right and is still a display lying about which settings
    a button will change. Proved red first by marking a held row.

    The layout half is measured rather than eyeballed: the marks must not push
    a row onto a second line, so a marked row's height and its label's left
    edge are compared against a held row's."""
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("12: the panel states Randomize's scope", False,
                      "could not open the panel")
    page.wait_for_timeout(400)

    said = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const sp = await import('./js/settings_panel.js');
      const rows = [...document.querySelectorAll('.tuner-row')];
      // THE PANEL'S OWN SCOPE, not tuner.js's slider scope. `randomizeScope`
      // answers "which SLIDERS does a roll move", which was the whole story
      // until 0.7.0 merged the theme in -- Randomize now rolls the element
      // catalogue too, so the slider count (47) is no longer what the button
      // does (69). Reading the wrong one here made this case demand that the
      // panel print a number smaller than its own behavior.
      const scope = sp.panelScope();
      const el = document.querySelector('.tuner-scope');
      const marked = rows.map((r) => {
        const m = r.querySelector('.tuner-mark');
        return !!(m && m.textContent.trim());
      });
      // The class the panel also sets, read here rather than left as an unused
      // hook -- an unread hook is indistinguishable from a dead one. It must
      // agree with the glyph exactly: two ways of saying "Randomize touches
      // this row" that can disagree is the same drift `isRandomized` exists to
      // stop, one layer out.
      const classed = rows.map((r) => r.classList.contains('tuner-can-random'));
      // The layout cost of the mark, measured as a straight A/B on the live
      // panel rather than by comparing marked rows against held ones. Several
      // labels already wrap at 380px for reasons that have nothing to do with
      // this glyph -- measured, row heights are 31px and 42px with the marks
      // removed entirely -- so "all rows are the same height" is the wrong
      // question and fails on a working mark. The right one is whether
      // BLANKING every mark changes any row's geometry.
      const geom = () => rows.map((r) => {
        const box = r.getBoundingClientRect();
        const lab = r.querySelector('.tuner-label').getBoundingClientRect();
        return [Math.round(box.height), Math.round(lab.left)];
      });
      const withMarks = geom();
      const texts = rows.map((r) => r.querySelector('.tuner-mark').textContent);
      rows.forEach((r) => { r.querySelector('.tuner-mark').textContent = ''; });
      const blanked = geom();
      rows.forEach((r, i) => { r.querySelector('.tuner-mark').textContent = texts[i]; });
      const mk = rows.find((r, i) => marked[i]);
      const swatch = mk
        ? getComputedStyle(mk.querySelector('.tuner-mark')).color : null;
      return {
        text: el ? el.textContent : null,
        // What the pure layer says, so the case follows the judgement rather
        // than carrying a second copy of it.
        expected: scope.count,
        expectedHeld: scope.heldCount,
        flagged: t.tunerRows().map((r) => sp.panelRolls(r)),
        marked, classed,
        markCount: marked.filter(Boolean).length,
        withMarks, blanked, swatch,
      };
    }""")

    text = said["text"] or ""
    # The visible copy has to carry the scope in words AND the derived count --
    # a number with no sentence around it is not an explanation, and a sentence
    # with a hardcoded number is the staleness this exists to stop.
    #
    # `expected` is randomizeScope().count, which is the SAME source the copy
    # was built from, so this pair alone is self-referential: a randomizeScope
    # returning `rolled.length + 1` would print "18 settings" on the wall and
    # still be reported as stating it correctly. The clause that closes it is
    # `markCount == expected` -- the marks are counted off the rendered DOM, and
    # `agrees` below ties those to what the button actually moved, so the
    # printed number reaches the behavior through two measured hops rather than
    # agreeing with itself.
    states_it = ("how the display looks" in text
                 and f"only the {said['expected']} settings" in text
                 and f"other {said['expectedHeld']}" in text
                 and "•" in text
                 and said["markCount"] == said["expected"])

    clicked = click_panel_button(page, ".tuner-randomize")
    page.wait_for_timeout(500)
    moved = page.evaluate("""() => [...document.querySelectorAll('.tuner-row')]
      .map((r) => r.classList.contains('tuner-dirty'))""")

    # Row by row, not count against count.
    agrees = (moved == said["marked"] and said["marked"] == said["flagged"]
              and said["classed"] == said["marked"])
    # Every row identical in height and label position with the marks present
    # and with them blanked: the mark costs exactly zero layout, so it cannot be
    # what pushes a row onto a second line.
    free = said["withMarks"] == said["blanked"]
    # Not the alarm amber: #dda825 means "blocked" everywhere else here.
    not_amber = said["swatch"] not in (None, "rgb(221, 168, 37)")

    click_and_confirm(page, ".tuner-revert")
    page.wait_for_timeout(300)

    ok = bool(states_it and clicked and agrees and free and not_amber)
    diff = [i for i, (a, b) in enumerate(zip(said["withMarks"], said["blanked"]))
            if a != b]
    return report(
        "12: the panel states Randomize's scope, and the marks match what it "
        "moves", ok,
        f"text={text!r}; states it={states_it} "
        f"(printed {said['expected']} vs {said['markCount']} marks rendered); "
        f"marked={said['markCount']} rows, "
        f"randomize moved={sum(1 for m in moved if m)}, per-row agreement="
        f"{agrees}; geometry unchanged with the marks blanked={free} "
        f"(rows that moved={diff or 'none'}, heights seen="
        f"{sorted({h for h, _ in said['withMarks']})}); "
        f"mark color={said['swatch']} (alarm amber avoided={not_amber})")


def live_arcs(page):
    return page.evaluate("() => window.__netviz.arcs.liveCount()")


def case13_rebuild_rows_warn_and_clear(page, cx, cy) -> bool:
    """13: the rows that clear the arc pool say so, and really do clear it.

    THREE CLAIMS, and each of the other two is what makes the remaining one
    evidence rather than a coincidence.

    The mark: every row `tuner.js` reports as `rebuilds` carries the glyph and
    no other row does, compared row by row against the rendered DOM rather
    than by count -- a warning on the wrong row keeps the total right and is
    still a display lying about which slider is about to empty the wall.

    The behavior: dragging one of them really does take the live arc count to
    zero, and it comes back. `arcs.rebuild()` retires the pool, so the wall
    blanks and refills from the feed over the next few seconds. Without the
    recovery half this case would pass against a panel that killed the arcs
    permanently, which is the failure the warning would then be describing
    honestly and nobody would want.

    The control: dragging a `uniform` row of the SAME class does NOT collapse
    the count. On a live page arcs come and go constantly, so "the count fell"
    on its own is also what an ordinary lull looks like; the pair is what
    separates the pool clear from the weather.

    The control row is also asserted to carry NO mark, and that clause is what
    stops the mark half being self-referential: the marks are compared against
    `clearsArcs`, which is the source they are drawn from, so a row wrongly
    flagged as rebuilding agrees with itself all the way down. Naming one row
    that must not be marked and then proving it does not clear the pool is the
    pair that catches it. (`tuner.test.mjs` holds the flag to apply.js's
    ARC_REBUILD_KEYS as well, which is the cheaper half of the same check.)

    It runs on a rebuild row that is a FLOW -- flows arrive tens per second on
    the synthetic feed, so the refill is observable inside a few seconds.
    Blocks arrive rarely and live 18s, which is why the same case pointed at
    `arcs.block.tube` would measure the feed's luck rather than the panel."""
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("13: the rebuilding rows warn, and really do clear the "
                      "arcs", False, "could not open the panel")
    page.wait_for_timeout(400)

    said = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const rows = [...document.querySelectorAll('.tuner-row')];
      const specs = t.tunerRows();
      const note = document.querySelector('.tuner-rebuild-note');
      const idx = (p) => specs.findIndex((r) => r.path === p);
      return {
        // What the pure layer says, and what the DOM drew, per row.
        flagged: specs.map((r) => t.clearsArcs(r)),
        // The two rows the behavior half drives, by path: one must be marked
        // and one must not, or the pair proves nothing.
        rebuildRowMarked: !!rows[idx(REBUILD)]
          && !!rows[idx(REBUILD)].querySelector('.tuner-rebuild'),
        controlRowMarked: !!rows[idx(CONTROL)]
          && !!rows[idx(CONTROL)].querySelector('.tuner-rebuild'),
        marked: rows.map((r) => !!r.querySelector('.tuner-rebuild')),
        classed: rows.map((r) => r.classList.contains('tuner-rebuilds')),
        rowCount: rows.length,
        specCount: specs.length,
        expected: specs.filter(t.clearsArcs).length,
        note: note ? note.textContent : null,
        // The mark must sit INSIDE the label, or it is a sixth flex child
        // competing with the slider for a 380px row.
        insideLabel: rows.every((r) => {
          const m = r.querySelector('.tuner-rebuild');
          return !m || r.querySelector('.tuner-label').contains(m);
        }),
      };
    }""".replace("REBUILD", repr(REBUILD_ROW)).replace("CONTROL", repr(CONTROL_ROW)))

    note = said["note"] or ""
    n = said["expected"]
    # The count in the copy is derived; this ties it to the marks the DOM
    # actually rendered, the same two-hop the scope line gets in case 12.
    states_it = (n > 0 and f"The {n} rows marked" in note
                 and "↻" in note and "come back" in note
                 and sum(1 for m in said["marked"] if m) == n)
    agrees = (said["marked"] == said["flagged"]
              and said["classed"] == said["marked"]
              and said["rowCount"] == said["specCount"]
              and said["insideLabel"]
              and said["rebuildRowMarked"] and not said["controlRowMarked"])

    # Now the behavior. A rebuild row first.
    #
    # The count is read SYNCHRONOUSLY, in the same evaluate that dispatches the
    # event and with no await between the two. `drag_slider` waits 60ms before
    # reporting, which is long enough for the render loop to spawn a fresh arc
    # into the pool it just emptied -- measured, one arc, and the case failed on
    # `cleared == 1` against a working clear. What is being proved is that the
    # handler retires the pool, so the read has to happen before a frame runs.
    before = live_arcs(page)
    out = page.evaluate("""async ({path, value}) => {
      const t = await import('./js/tuner.js');
      const idx = t.tunerRows().findIndex((r) => r.path === path);
      if (idx < 0) return {error: `tuner has no row for ${path}`};
      const rows = [...document.querySelectorAll('.tuner-row')];
      if (rows.length !== t.tunerRows().length) {
        return {error: `panel drew ${rows.length} rows, tuner.js declares ${rows.length}`};
      }
      const range = rows[idx].querySelector('.tuner-range');
      if (!range) return {error: `${path} is not a slider row`};
      range.value = String(value);
      range.dispatchEvent(new Event('input', {bubbles: true}));
      // No await here, deliberately -- see above.
      return {cleared: window.__netviz.arcs.liveCount(),
              dirtyClass: rows[idx].classList.contains('tuner-dirty')};
    }""", {"path": REBUILD_ROW, "value": REBUILD_TARGET})
    if out.get("error"):
        return report("13: the rebuilding rows warn, and really do clear the "
                      "arcs", False, out["error"])
    cleared = out["cleared"]
    recovered = 0
    t0 = time.time()
    while time.time() - t0 < REFILL_CAP_SECONDS:
        recovered = live_arcs(page)
        if recovered > 0:
            break
        page.wait_for_timeout(250)
    click_and_confirm(page, ".tuner-revert")
    page.wait_for_timeout(400)

    # ...and the control: a uniform row of the same class must not empty it.
    page.wait_for_timeout(1500)
    base2 = live_arcs(page)
    out2 = drag_slider(page, CONTROL_ROW, CONTROL_TARGET)
    if out2.get("error"):
        return report("13: the rebuilding rows warn, and really do clear the "
                      "arcs", False, out2["error"])
    after_control = live_arcs(page)
    click_and_confirm(page, ".tuner-revert")
    page.wait_for_timeout(300)
    close_panel(page)

    # `before` has to be non-trivial or "it went to zero" means nothing.
    had_arcs = before >= 5
    emptied = cleared == 0 and out["dirtyClass"]
    came_back = recovered > 0
    control_ok = base2 >= 5 and after_control > 0
    ok = bool(states_it and agrees and had_arcs and emptied and came_back
              and control_ok)
    return report(
        "13: the rebuilding rows warn, and really do clear the arcs", ok,
        f"note={note!r}; states it={states_it} ({n} declared, "
        f"{sum(1 for m in said['marked'] if m)} marks rendered), per-row "
        f"agreement={agrees} (mark inside the label={said['insideLabel']}, "
        f"{REBUILD_ROW} marked={said['rebuildRowMarked']}, {CONTROL_ROW} "
        f"marked={said['controlRowMarked']}); "
        f"{REBUILD_ROW}: live arcs {before} -> {cleared} (emptied={emptied}, row "
        f"marked dirty={out['dirtyClass']}) -> "
        f"{recovered} (came back={came_back}); control {CONTROL_ROW}: {base2} -> "
        f"{after_control} (still drawn={control_ok})")


def case14_close_can_keep(page, cx, cy) -> bool:
    """14: the Close question's middle button keeps the pending rows, then closes.

    "Close" and "Keep" were two separate decisions a person almost always makes
    together, and reaching the second one meant cancelling out of the dialog
    offering the first. The third button does both, and it has to do them in
    that order: closePanel() reverts whatever is still dirty, so a wiring that
    closed first would revert the very values it was about to write -- and the
    panel would shut looking exactly as if it had worked.

    Which is why all three are read after the click: the panel is gone, the
    STORE carries the row, and the WALL is still at the dragged value rather
    than back at the baseline. The store alone is passed by a keep that wrote
    and then reverted the display; the wall alone is passed by a close that
    never wrote at all.

    Cleans up after itself -- main()'s finally restores the whole key, but a
    case that leaves a row kept changes the baseline every later case reads."""
    name = "14: Close can keep instead of discarding"
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report(name, False, "could not open the tuning panel")
    page.wait_for_timeout(400)

    store_base = read_store(page)
    base = read_live(page, OPACITY)
    out = drag_slider(page, OPACITY, OPACITY_TARGET)
    if out.get("error"):
        return report(name, False, out["error"])
    moved = read_live(page, OPACITY)

    clicked = click_panel_button(page, ".tuner-close")
    page.wait_for_timeout(300)
    state = confirm_state(page)
    seen = confirm_is_really_open(state)
    # The middle button exists ONLY when altLabel is set, so its absence here
    # is the whole regression this case guards -- not a detail of the click.
    alt_present = page.evaluate(
        "() => !!document.querySelector('.confirm .confirm-alt')")
    alt_clicked = page.evaluate("""() => {
      const b = document.querySelector('.confirm .confirm-alt');
      if (!b) return false;
      b.click();
      return true;
    }""") if alt_present else False
    page.wait_for_timeout(500)

    after = {
        "panel": panel_is_really_open(panel_state(page)),
        "live": read_live(page, OPACITY),
        "store": read_store(page),
    }
    parsed = json.loads(after["store"]) if after["store"] else {}
    stored = parsed.get(OPACITY)
    ok = (clicked and seen and alt_present and alt_clicked
          and not after["panel"]
          and stored is not None and abs(stored - OPACITY_TARGET) < 1e-9
          and abs((after["live"] or 0) - OPACITY_TARGET) < 1e-9
          and moved != base)

    # PUT BOTH BACK WITHOUT A RELOAD. The first cut reloaded here, and that was
    # wrong twice over: a reload costs 30s+ under SwiftShader and timed out
    # under load, taking the four cases that run after this one down with it --
    # and it was never necessary. The store is restored directly, and the LIVE
    # value is put back through the applier, because the next case reads
    # cfg() and not localStorage.
    if isinstance(base, (int, float)):
        page.evaluate("(v) => window.__netviz.settings.apply({'arcs.bodyOpacity': v})",
                      base)
    # AFTER the re-apply, not before: `settings` is the persisting applier, so
    # putting the wall back writes to the store as well and would undo a restore
    # done first.
    restore_store(page, store_base)
    page.wait_for_timeout(300)

    return report(
        name, ok,
        f"{OPACITY} base={base} -> drag {moved}; asked={seen} alt button "
        f"present={alt_present} clicked={alt_clicked}; after: panel "
        f"open={after['panel']} (must be False), live={after['live']} "
        f"(must stay {OPACITY_TARGET}, not revert to {base}), stored={stored}")


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
    ok &= case6_cancel_is_safe(page, cx, cy)
    ok &= case7_camera_held(page, cx, cy)
    ok &= case8_menu_mutual_exclusion(page, cx, cy)
    ok &= case9_randomize(page, cx, cy)
    ok &= case14_close_can_keep(page, cx, cy)
    ok &= case12_randomize_scope_is_stated(page, cx, cy)
    ok &= case13_rebuild_rows_warn_and_clear(page, cx, cy)
    # Last, because it resizes the viewport. It restores it, but a case that
    # moves the ground under the others is one that should have as little
    # after it as possible.
    ok &= case10_hover(page, cx, cy)
    ok &= case11_small_viewport(page)
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
            # Case 4 clicks a real Keep, so this run WILL write to a stored
            # patch -- but `new_context()` above isolates origin storage, so
            # that patch is this run's own and never a real display's, even
            # with --url. Snapshotted here and written back in the `finally`
            # below all the same: it costs nothing, and it is what keeps this
            # honest if anyone ever swaps in launch_persistent_context().
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
