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
    `requestClose()` rather than the force-close, so picking "Color rules..."
    over unkept changes asks instead of discarding them silently, and a
    Cancel leaves the rules panel shut and the changes pending;
  * that Shuffle rolls every slider inside its own schema bounds, marks each
    row dirty exactly as a drag does, asks nothing, and is undone by one
    Revert;
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
    which a Keep persisting all 24 rows would satisfy, the exact failure the
    panel's dirty-tracking exists to prevent (24 values frozen at today's
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
    actually gets that: after cancelling a Close, the panel must still be open,
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

    cancelled = answer_confirm(page, False)
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

    ok = (asked_ok and names_row and cancelled and safe and confirmed_ok
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


def case10_small_viewport(page) -> bool:
    """10: on a small viewport the slice is clamped, and the stage stays usable.

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
        f"10: at {SMALL_VIEWPORT[0]}x{SMALL_VIEWPORT[1]} the slice is clamped and "
        "the stage stays usable", ok,
        f"viewport {after['vw']}px: stage {before['stage']['w']} -> "
        f"{after['stage']['w']} (slice {slice_w}, panel {panel_w}, agree={matches}), "
        f"canvas {before['canvas']['w']}x{before['canvas']['h']} -> "
        f"{after['canvas']['w']}x{after['canvas']['h']}, camera aspect "
        f"{before['aspect']} -> {after['aspect']} (finite and positive={aspect_ok}), "
        f"stage keeps the majority={majority}, usable={usable}, "
        f"panelOpen={panel_is_really_open(state)}")


def rules_panel_open(page) -> bool:
    """The color-rules panel's own element, on the same terms as the tuning
    panel's: in the document with a non-zero rect."""
    return bool(page.evaluate("""() => {
      const el = document.querySelector('.rules-panel');
      if (!el || !document.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }"""))


def case8_menu_mutual_exclusion(page, cx, cy) -> bool:
    """8: opening "Color rules..." over pending changes ASKS, and a Cancel
    leaves everything where it was.

    menu.js enforces mutual exclusion between the two panels by closing this
    one before opening the other. While that call was the force-close, an
    operator with unkept changes who picked "Color rules..." had them discarded
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
    page.evaluate("() => window.__netviz.rulesPanel && window.__netviz.rulesPanel.close()")
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
    clicked = open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    asked = confirm_state(page)
    asked_ok = confirm_is_really_open(asked) and asked.get("yes") and asked.get("no")
    cancelled = answer_confirm(page, False)
    page.wait_for_timeout(400)
    after_cancel = {
        "rules": rules_panel_open(page),
        "tuner": panel_is_really_open(panel_state(page)),
        "live": read_live(page, OPACITY),
        "dirty": page.evaluate(
            "() => document.querySelectorAll('.tuner-row.tuner-dirty').length"),
        "store": read_store(page),
    }
    safe = (clicked and asked_ok and cancelled
            and not after_cancel["rules"] and after_cancel["tuner"]
            and abs((after_cancel["live"] or 0) - OPACITY_TARGET) < 1e-9
            and after_cancel["dirty"] >= 1
            and after_cancel["store"] == store_base)

    # Then through it for real.
    clicked2 = open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    asked2 = confirm_is_really_open(confirm_state(page))
    answered2 = answer_confirm(page, True) if asked2 else False
    page.wait_for_timeout(500)
    after = {
        "rules": rules_panel_open(page),
        "tuner": panel_is_really_open(panel_state(page)),
        "live": read_live(page, OPACITY),
        "store": read_store(page),
    }
    through = (clicked2 and asked2 and answered2
               and after["rules"] and not after["tuner"]
               and abs((after["live"] or 0) - base) < 1e-9
               and after["store"] == store_base)

    page.evaluate("() => window.__netviz.rulesPanel && window.__netviz.rulesPanel.close()")
    page.wait_for_timeout(200)

    ok = safe and through and abs(moved - OPACITY_TARGET) < 1e-9 and moved != base
    return report(
        "8: the menu asks before dropping pending changes for the rules panel", ok,
        f"{OPACITY} base={base} -> drag {moved}; Color rules asked={asked_ok}; after "
        f"Cancel: rules panel open={after_cancel['rules']} (must be False), tuning "
        f"panel open={after_cancel['tuner']}, live still {after_cancel['live']}, rows "
        f"marked dirty={after_cancel['dirty']}, store unchanged="
        f"{after_cancel['store'] == store_base} (safe={safe}); then confirmed: "
        f"asked={asked2} tuner gone={not after['tuner']} rules open={after['rules']} "
        f"live -> {after['live']} store unchanged={after['store'] == store_base}")


def case9_shuffle(page, cx, cy) -> bool:
    """9: Shuffle moves every slider, inside the bounds, with no dialog -- and
    one Revert puts the whole lot back.

    `shuffleValue` is proved against the real catalogue under `node --test`;
    what only a page can show is that the BUTTON is wired to it, that every row
    it touches is marked dirty exactly as a drag's is, that it does NOT ask
    (Keep, Revert and Close all do, and a dialog in front of the quick button is
    what would teach people to click through the other three), and that the
    values that land on the wall are the ones the applier accepted.

    The bounds are read from tuner.js itself rather than written here, so a
    schema change moves the assertion with the control."""
    close_panel(page)
    page.wait_for_timeout(250)
    if not open_menu_and_click(page, "settings", cx, cy):
        return report("9: Shuffle rolls every slider inside its bounds, and "
                      "Revert puts them back", False, "could not open the panel")
    page.wait_for_timeout(400)

    store_base = read_store(page)
    before = page.evaluate("""async () => {
      const t = await import('./js/tuner.js');
      const c = await import('./js/config.js');
      const out = {};
      for (const r of t.tunerRows()) out[r.path] = c.cfg(r.path, null);
      return out;
    }""")
    clicked = click_panel_button(page, ".tuner-shuffle")
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
        dirty: document.querySelectorAll('.tuner-row.tuner-dirty').length,
        sliders: rows.filter((r) => r.control === 'slider').length,
        count: (document.querySelector('.tuner-count') || {}).textContent,
        note: (document.querySelector('.tuner-note') || {}).textContent,
      };
    }""")

    inside = [p for p, b in after["bounds"].items()
              if not (b["min"] - 1e-9 <= after["vals"][p] <= b["max"] + 1e-9)]
    # Every non-slider must be untouched: the color row's luminance cap refuses
    # rather than clamps, so a randomizer reaching it would read as broken.
    others = [p for p in before
              if p not in after["bounds"] and after["vals"][p] != before[p]]
    moved = sum(1 for p in after["bounds"] if after["vals"][p] != before[p])

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

    ok = (clicked and not dialog and not inside and not others
          # A shuffle that moved one slider and left 20 alone is not a shuffle.
          # Not `== sliders`: a roll can legitimately land a row back on the
          # value it already held.
          and moved >= after["sliders"] - 2
          and after["dirty"] >= after["sliders"] - 2
          and reverted_click and revert_dialog and revert_answered
          and not restored and store_after == store_base)
    return report(
        "9: Shuffle rolls every slider inside its bounds, and Revert puts them "
        "back", ok,
        f"clicked={clicked} asked={dialog} (must be False); {moved}/{after['sliders']} "
        f"sliders moved, {after['dirty']} rows marked dirty, out of bounds={inside}, "
        f"non-sliders touched={others}, note={after['note']!r}; after Revert "
        f"(asked={revert_dialog}): rows still changed={restored}, store unchanged="
        f"{store_after == store_base}")


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
    ok &= case9_shuffle(page, cx, cy)
    # Last, because it resizes the viewport. It restores it, but a case that
    # moves the ground under the others is one that should have as little
    # after it as possible.
    ok &= case10_small_viewport(page)
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
