#!/usr/bin/env python3
"""Prove the THEME PANEL against a real page.

Modeled on `tools/verify_tuner.py` -- same rail, same preview/persist split,
same one confirm.js dialog -- because `js/theme_panel.js` is that panel's
sibling and shares its whole mechanism. Read
`docs/notes/settings-and-panels.md`'s theme section before touching this file.

Eight cases, from spec section 11:

  1. the panel opens, mounts on `document.body` (never `#stage`), narrows
     `#stage` by exactly its own width, and each toggle costs exactly one
     `renderer.setSize` -- the same left-rail contract the tuning panel makes,
     proved the same way it was proved there;
  2. opening the theme panel closes an open TUNING panel through its
     `requestClose()`, not a force-close -- a pending tuner change raises the
     one confirm dialog, and Cancel leaves both panels exactly as they were:
     the tuner still open and dirty, the theme panel never opened;
  3. each of the five presets visibly recolors the GLOBE, proved by sampling
     the drawing buffer rather than by trusting the schema. A region ON the
     globe disc and a region of empty sky are sampled SEPARATELY -- see
     `sample_region()` -- because a whole-frame mean dilutes any change
     confined to the globe into noise dominated by arcs, stars and a
     nondeterministic camera (a reviewer's point on this plan, and the exact
     failure a first draft of this case had). There is no golden image: the
     arc feed is live and no two frames match, so what is asserted is that
     the globe region's HUE actually moves between presets, plus a sanity
     check that the "globe" box really is brighter than the "sky" box, which
     is what proves the box was on the disc rather than a lucky patch of
     black;
  4. an element explicitly overridden away from `auto` SURVIVES a theme
     change (the stored hex holds, the row stays marked not-auto); an element
     left on `auto` does NOT -- its resolved swatch tracks the new ramp,
     proved by reading the row's own `<input type=color>` value across the
     switch, not by re-deriving what it ought to be;
  5. the `↺` button on an overridden row returns that one element to
     `auto`, and its swatch immediately matches the theme's current color at
     that element's own `t` -- read from `js/elements.js`'s table via the
     page's own `resolveColor()`, not recomputed here;
  6. Chaos marks all twelve element rows dirty in one click, asks nothing
     itself, and leaves the preset selector alone (chaos never touches the
     ramp) -- then Close, now facing twelve pending changes, DOES ask, and
     answering yes discards all twelve and reverts the wall;
  7. `appearance.background` is not a row on this panel -- it lives on the
     tuning panel -- but its DERIVED luminance cap moves with the active
     ramp, and this is the one place that interaction can be exercised end to
     end: a background legal under one theme's cap can become illegal under
     a stricter one, and the write is REFUSED with a reason naming the
     measured luminance and the cap, never silently darkened. Asserted on the
     rejection payload, not on pixels, and the sky (`scene.background`) is
     read before and after to prove a refusal really did leave it untouched;
  8. editing a gradient stop forks the active preset to `custom` on first
     touch (one `preview.apply()` carrying both `appearance.theme: 'custom'`
     and the full ten-stop array) -- and picking the preset back off the
     selector restores its ORIGINAL ten stops exactly, because reselecting a
     named preset only ever writes `appearance.theme`, never touching
     `appearance.customRamp`. The forked array is still sitting in
     `appearance.customRamp` afterward, read back live, proving "restores it
     intact" describes the preset's own colors and not a discarded edit.

PROVE EVERY CASE RED FIRST. Every case below has now been measured against
a genuinely broken state and restored, with the exact break and the exact
failed output recorded in each case's own docstring:

  - Cases 1, 2, 5, 6, 7, 8 against a deliberately broken BUILD (one small
    edit to the relevant source file, reverted after).
  - Case 3 against a deliberately broken RUN of this case itself (its own
    `PRESET_IDS` collapsed to five copies of the same preset -- the
    observable effect of a no-op ramp selector -- with no source file
    touched at all). Its floor, `CASE3_RGB_DIST_MIN`, is set from measured
    noise and measured signal, not from taste; see that constant's own
    comment for both numbers and how thin the margin actually is.
  - Case 4 needed no injected break: it was found RED against the shipped,
    unmodified tree (a real pre-existing defect in `theme_panel.js`'s
    `syncRow`, since fixed upstream) rather than a synthetic one, arguably
    the strongest evidence this file produced.

This project has shipped a guard that passed everything twice (a quoted
rev-list range that scanned nothing, and a CSS rule that never parsed) --
a verifier that cannot fail is indistinguishable from a clean run.

    python3 tools/verify_theme.py
    python3 tools/verify_theme.py --url http://HOST:8099/
"""
import argparse
import colorsys
import io
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

try:
    from PIL import Image, ImageStat
except ImportError as e:  # pragma: no cover -- environment problem, not a test failure
    print("verify_theme.py needs Pillow to decode the sampled regions "
          "(pip install pillow) -- same tool-only dependency tools/bake_geo.py "
          "already assumes.", file=sys.stderr)
    raise

REPO = Path(__file__).resolve().parent.parent
# Its own port. verify_rules.py and verify_menu.py share 8499, verify_settings
# owns 8399, verify_rules_editor owns 8599, verify_tuner owns 8699 -- a sixth
# verifier reusing any of them would read as a flaky test rather than the
# resource conflict it is.
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8799"))

STORE_KEY = "netviz.settings.v1"

RESULTS: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    RESULTS.append((name, ok, detail))
    return ok


# ---------------------------------------------------------------- plumbing --
# Copied from verify_tuner.py / verify_menu.py rather than imported: these
# scripts share no runtime, only a convention, and a fifth copy diverging is
# cheaper to notice than a shared helper module nobody remembers to update.

def dispatch_contextmenu(page, x, y):
    return page.evaluate("""({x, y}) => {
      const canvas = document.querySelector('canvas');
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      });
      const notCanceled = canvas.dispatchEvent(ev);
      return !notCanceled;
    }""", {"x": x, "y": y})


def open_menu_and_click(page, data_id: str, cx: float, cy: float) -> bool:
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


def theme_panel_state(page):
    """`.theme-panel` is a unique class -- the tuning panel's root carries
    `tuner-panel` alone, the theme panel's carries `tuner-panel theme-panel`
    (see theme_panel.js's own comment on why the two classes are deliberately
    different strings). Presence + `document.contains` + a non-zero rect,
    never the API's own claim -- there is no API claim available here at all:
    `window.__netviz` exposes `settingsPanel` and `customArcsPanel` but not
    `themePanel`, so this script never has one to distrust in the first
    place and drives everything through the DOM and the menu, the same
    surface a real operator has."""
    return page.evaluate("""() => {
      const el = document.querySelector('.theme-panel');
      if (!el) return {present: false};
      const r = el.getBoundingClientRect();
      return {
        present: true, inDocument: document.contains(el),
        mountedOnBody: el.parentElement === document.body,
        w: r.width, h: r.height,
        rows: el.querySelectorAll('.theme-row').length,
      };
    }""")


def panel_is_really_open(state) -> bool:
    return bool(state.get("present") and state.get("inDocument")
                and state.get("w", 0) > 0 and state.get("h", 0) > 0)


def confirm_state(page):
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


def click_panel_button(page, cls) -> bool:
    return page.evaluate("""(cls) => {
      const b = document.querySelector(cls);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }""", cls)


def click_and_confirm(page, cls, yes: bool = True):
    clicked = click_panel_button(page, cls)
    page.wait_for_timeout(250)
    state = confirm_state(page)
    seen = confirm_is_really_open(state)
    answered = answer_confirm(page, yes) if seen else False
    page.wait_for_timeout(250)
    return clicked, seen, answered, state


def read_live(page, path):
    return page.evaluate("""async (p) => {
      const m = await import('./js/config.js');
      return m.cfg(p, null);
    }""", path)


def read_store(page):
    return page.evaluate("(k) => window.localStorage.getItem(k)", STORE_KEY)


def restore_store(page, original):
    """See verify_tuner.py's own restore_store: Playwright's `new_context()`
    isolates origin storage per run, so this is defense for the day that
    changes, and case 7's DELTA-shaped assertions are the part that survives
    if it ever does."""
    return page.evaluate("""({k, original}) => {
      if (original === null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, original);
      return window.localStorage.getItem(k);
    }""", {"k": STORE_KEY, "original": original})


def close_any_open_panel(page):
    """Force-close whichever of the tuning/theme panels is open, discarding
    anything pending. Both panels' Close button shares the class
    `.tuner-close` (only one panel is ever mounted, so this is unambiguous),
    and clicking it asks first only when something is dirty -- so this loop
    answers Yes if asked and stops once nothing with that class remains.
    Harness-only teardown, exactly like verify_tuner.py's close_panel(), but
    driven through the real button because neither panel exposes a
    programmatic close on `window.__netviz`."""
    for _ in range(4):
        if not page.evaluate("() => !!document.querySelector('.tuner-close')"):
            return
        clicked = click_panel_button(page, ".tuner-close")
        if not clicked:
            return
        page.wait_for_timeout(200)
        if confirm_is_really_open(confirm_state(page)):
            answer_confirm(page, True)
        page.wait_for_timeout(300)


def element_keys(page):
    """The twelve element keys, read from the page's own module rather than
    hardcoded here -- a schema change moves this list with the code, the same
    argument case9 in verify_tuner.py makes for `tuner.js`'s `randomize`
    flag."""
    return page.evaluate(
        "async () => (await import('./js/theme_panel.js')).ELEMENT_KEYS")


def reset_theme_defaults(page, keys):
    """Put every theme-owned path back to its shipped default, THROUGH THE
    PERSISTING APPLIER, with the panel closed. Deliberately not routed through
    the panel: this is inter-case isolation, not something under test, and
    doing it while a panel was open would leave that panel's own `current`/
    `snapshot` maps stale against the live config it no longer agrees with.
    Every case that needs a clean baseline calls this, then opens its own
    panel fresh -- `open()` reads `defaultOf()` at that moment, so it always
    starts from what this just wrote."""
    close_any_open_panel(page)
    patch = {"appearance.theme": "plasma", "appearance.background": "auto"}
    for k in keys:
        patch[f"appearance.colors.{k}"] = "auto"
    page.evaluate("(p) => window.__netviz.settings.apply(p)", patch)
    page.wait_for_timeout(150)


def open_theme_panel(page, cx, cy) -> bool:
    clicked = open_menu_and_click(page, "theme", cx, cy)
    page.wait_for_timeout(400)
    return clicked and panel_is_really_open(theme_panel_state(page))


def row_index(page, keys, key):
    return keys.index(key)


def element_row_state(page, idx):
    """One `.theme-row`'s controls, by index -- the color input's OWN value
    (what the swatch actually shows, which tracks the theme for an `auto`
    row) and the hex span's text (which theme_panel.js deliberately prints as
    the literal string 'auto' for an auto row, never a color -- see
    syncElementRow), plus the dirty class."""
    return page.evaluate("""(i) => {
      const rows = document.querySelectorAll('.theme-row');
      const row = rows[i];
      if (!row) return null;
      return {
        colorValue: row.querySelector('.tuner-color').value,
        hexText: row.querySelector('.tuner-hex').textContent,
        dirty: row.classList.contains('tuner-dirty'),
      };
    }""", idx)


def set_element_color(page, idx, hex_value):
    return page.evaluate("""({i, hex}) => {
      const rows = document.querySelectorAll('.theme-row');
      const row = rows[i];
      const input = row.querySelector('.tuner-color');
      input.value = hex;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }""", {"i": idx, "hex": hex_value})


def click_revert_el(page, idx):
    return page.evaluate("""(i) => {
      const rows = document.querySelectorAll('.theme-row');
      const btn = rows[i].querySelector('.theme-revert-el');
      if (!btn) return false;
      btn.click();
      return true;
    }""", idx)


def resolve_color(page, key):
    """`resolveColor(key, 'auto')` as the PAGE computes it right now -- the
    one reader both the panel and every render-path handler use, per
    elements.js's own comment. Never re-derived in Python: a drift between
    this script's math and the page's would be indistinguishable from a real
    bug."""
    return page.evaluate("""async (k) => {
      const m = await import('./js/elements.js');
      return m.resolveColor(k, 'auto');
    }""", key)


def set_preset(page, preset_id):
    return page.evaluate("""(id) => {
      const sel = document.querySelector('.theme-preset');
      sel.value = id;
      sel.dispatchEvent(new Event('change', {bubbles: true}));
    }""", preset_id)


def gradient_stops(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('.theme-stop')].map((el) => el.value)")


def set_gradient_stop(page, idx, hex_value):
    return page.evaluate("""({i, hex}) => {
      const inputs = document.querySelectorAll('.theme-stop');
      const input = inputs[i];
      input.value = hex;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }""", {"i": idx, "hex": hex_value})


# ----------------------------------------------------------- pixel sampling --
# Case 3 only. Playwright's `page.screenshot(clip=...)` goes through the
# browser's own compositor (CDP `Page.captureScreenshot`), not a JS-side
# `canvas.getImageData()` -- so this works whether or not the renderer was
# built with `preserveDrawingBuffer`, which it is not (main.js:
# `new THREE.WebGLRenderer({canvas, antialias: true})`, no third option).

def sample_mean_rgb(page, box):
    """Mean RGB of every pixel in `box` (a Playwright clip rect), 0..255 per
    channel, via a real screenshot decoded with Pillow."""
    data = page.screenshot(clip=box)
    img = Image.open(io.BytesIO(data)).convert("RGB")
    r, g, b = ImageStat.Stat(img).mean
    return (r, g, b)


def rgb_to_hsv255(rgb):
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    return {"hue": h * 360, "sat": s, "val": v}


def rgb_distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def sample_region_averaged(page, box, n, gap_ms):
    """`n` screenshots of `box`, `gap_ms` apart, averaged per channel."""
    samples = []
    for i in range(n):
        samples.append(sample_mean_rgb(page, box))
        if i < n - 1:
            page.wait_for_timeout(gap_ms)
    return tuple(sum(c) / len(samples) for c in zip(*samples))


def canvas_regions(page):
    """The globe box (centered on the canvas, which is always where the
    sphere sits: the camera looks at the globe's own origin every frame, so
    the sphere's screen center is the canvas center regardless of camera
    orbit or which rail panel has narrowed it) and a sky box tucked in the
    canvas's own top-right corner, far from both the globe's silhouette and
    the panel occupying the left edge."""
    r = page.evaluate("""() => {
      const c = document.querySelector('canvas').getBoundingClientRect();
      return {x: c.x, y: c.y, w: c.width, h: c.height};
    }""")
    cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
    half = 350
    globe = {"x": cx - half, "y": cy - half, "width": half * 2, "height": half * 2}
    sky = {"x": r["x"] + r["w"] - 220, "y": r["y"] + 40, "width": 150, "height": 150}
    return globe, sky


# THE ARCS WERE THE NOISE, and this case is not about the arcs.
#
# Case 3 asks whether each preset recolors THE GLOBE. The globe box also
# catches whatever arcs happen to be in flight at the instant of the shot, and
# those are Poisson-driven and by far the brightest thing in the frame -- so
# they went into the measurement as noise, and for two years of this file's
# history the answer was to average more shots and warm up longer and hope the
# noise stayed under the floor.
#
# MEASURED, both sides, same box, same session:
#
#   arcs live (30s warmup, 4 shots averaged, exactly as this case used to run)
#     same-preset ceiling  2.97   (plasma sampled 6x, 15 pairwise distances)
#     closest real pair    3.23   (viridis/cividis)
#   arcs suppressed (rate to its floor + the pool cleared before each shot)
#     same-preset ceiling  0.08   (same 6x plasma, same 15 distances)
#     closest real pair    0.87   (magma/inferno)
#
# Suppressing the arcs drops the noise floor by a factor of 37 and the signal
# stops being buried. It also removes the reason the 30s warmup existed: the
# transient that warmup burned off was the arc pool filling, and a pool that is
# cleared before every shot has no transient to fill.
#
# WHAT THAT MEASUREMENT REVEALED, and it is the whole reason this case was
# failing: magma and inferno really do render this region 0.87 apart -- about
# one part in 255, which no eye will ever see. They are near-twin ramps (both
# begin #000004 and track each other closely) and the globe box is dominated by
# the LOW-t elements -- atmosphere at 0.20, world borders at 0.24, admin1 at
# 0.26 -- which is exactly where the two agree most. The 5.08 this file once
# recorded for that pair was arc noise landing high on the day it was measured,
# not a separation that was ever there. So the old floor of 4.0 was calibrated
# against an artifact, and no threshold could have made that pair pass.
CASE3_QUIET_FLOWS = 1        # traffic.flowsPerSecond' own schema floor
CASE3_QUIET_SETTLE_MS = 200  # one frame plus slack, after clearing the pool
CASE3_WARMUP_SECONDS = 3     # textures and shader compile only; no pool to fill
CASE3_SETTLE_MS = 800
# MEASURED: raising this from 2 to 4 nudged the same-preset noise ceiling
# down slightly (6 repeats of plasma, post-warmup: max pairwise distance 3.42
# at 2 samples/preset, 3.31 at 4 -- diminishing returns, since the residual
# noise is mostly TEMPORAL (which arcs happen to be in flight at the moment
# of the shot), not spatial undersampling, and averaging a few more frames a
# few hundred ms apart only shaves a little off a Poisson-driven signal).
# Kept at 4 anyway: it is free correctness (the floor below is set against
# what this actually measures) and any reduction in the noise ceiling is
# real margin.
CASE3_SAMPLES = 4
CASE3_SAMPLE_GAP_MS = 350
# Euclidean distance between two presets' mean RGB (0..255 per channel).
#
# RE-MEASURED with the arcs suppressed -- which is what the previous version of
# this comment instructed the next person to do ("if a future preset pair ever
# lands closer together than magma/inferno's 5.08, or the noise ceiling creeps
# up, RE-MEASURE both sides"). Both sides, same session, same box:
#
#   same-preset noise ceiling   0.08   (plasma sampled 6x, all 15 pairs)
#   closest real pair           0.87   (magma/inferno -- see the note above)
#   next-closest real pair      4.27   (viridis/cividis)
#
# 0.4 sits at 5x the noise ceiling and less than half the closest real pair.
#
# WHAT THIS FLOOR NOW CLAIMS, stated plainly so nobody reads more into it: that
# every preset really does reach the globe, and that no two presets are secretly
# the same ramp. It does NOT claim the two are telling apart by eye -- at 0.87,
# magma and inferno are not, and this file says so above rather than asserting
# something false. The lever that proves the case still has teeth is unchanged:
# with PRESET_IDS collapsed to ['plasma'] * 5 the distances are 0.00 and this
# floor still fails them.
CASE3_RGB_DIST_MIN = 0.4
CASE3_VAL_MARGIN = 0.02      # globe box brighter than the sky box by this much
PRESET_IDS = ["plasma", "viridis", "magma", "inferno", "cividis"]


# ------------------------------------------------------------------ cases --

def case1_geometry(page, cx, cy) -> bool:
    """1: the panel is really in the document, mounted on `document.body`
    (never `#stage` -- a fixed-position `#stage` creates a stacking context
    that would paint the panel under `#rail`, the exact bug the menu and the
    tuning panel each shipped once), narrows `#stage` by exactly its own
    width, and each direction costs exactly one `renderer.setSize`.

    RED FIRST, MEASURED: `document.body.classList.add('theme');` in
    theme_panel.js's `open()` was commented out (leaving the node itself
    appended normally). Result: `mountedOnBody` still true (the node
    genuinely is a child of body), but the CSS rule
    `body.theme #stage { left: ... }` never applied -- `stage` read
    `{w: 2560}` before AND after opening, `narrowed_by=0` against a panel
    width of 380 (`matches=False shifted=False`), while `clicked` and
    `panel present` stayed true -- exactly the failure mode `verify_menu.py`'s
    case 15 describes for the same stacking-context bug in a different
    panel. Restored and re-run clean before this file was finished."""
    close_any_open_panel(page)
    page.wait_for_timeout(300)

    def measure():
        return page.evaluate("""() => {
          const c = window.__netviz.renderer.domElement;
          const s = document.querySelector('#stage').getBoundingClientRect();
          return {w: c.width, h: c.height,
                  stage: {x: s.x, y: s.y, w: s.width, h: s.height}};
        }""")

    page.evaluate("""() => {
      const r = window.__netviz.renderer;
      window.__themeSetSize = {n: 0, orig: r.setSize.bind(r)};
      r.setSize = (...a) => { window.__themeSetSize.n += 1;
                              return window.__themeSetSize.orig(...a); };
    }""")
    calls = lambda: page.evaluate("() => window.__themeSetSize.n")  # noqa: E731

    try:
        before = measure()
        n0 = calls()
        clicked = open_menu_and_click(page, "theme", cx, cy)
        page.wait_for_timeout(600)
        state = theme_panel_state(page)
        opened = measure()
        n_open = calls() - n0

        panel_w = page.evaluate("""() => {
          const el = document.querySelector('.theme-panel');
          return el ? el.getBoundingClientRect().width : null;
        }""")

        close_any_open_panel(page)
        page.wait_for_timeout(600)
        closed = measure()
        n_close = calls() - n0 - n_open
    finally:
        page.evaluate("""() => {
          if (window.__themeSetSize) {
            window.__netviz.renderer.setSize = window.__themeSetSize.orig;
            delete window.__themeSetSize;
          }
        }""")

    narrowed_by = before["stage"]["w"] - opened["stage"]["w"]
    matches_panel = panel_w is not None and abs(narrowed_by - panel_w) < 1.0
    shifted = abs(opened["stage"]["x"] - (before["stage"]["x"] + panel_w)) < 1.0 \
        if panel_w is not None else False
    canvas_followed = opened["w"] < before["w"] and opened["h"] == before["h"]
    restored = closed == before
    ok = (clicked and panel_is_really_open(state) and state.get("mountedOnBody")
          and matches_panel and shifted and canvas_followed and restored
          and n_open == 1 and n_close == 1)
    return report(
        "1: the panel mounts on body, narrows the stage by its own width, "
        "one relayout each way", ok,
        f"mountedOnBody={state.get('mountedOnBody')}; stage {before['stage']} -> "
        f"{opened['stage']} -> {closed['stage']}; canvas {before['w']}x{before['h']} "
        f"-> {opened['w']}x{opened['h']}; panel width={panel_w} narrowed by "
        f"{narrowed_by} (matches={matches_panel}, left edge moved={shifted}); "
        f"setSize calls open={n_open} close={n_close}; restored exactly={restored}")


def case2_closes_tuner_first(page, cx, cy) -> bool:
    """2: opening the theme panel over a DIRTY tuning panel closes it through
    `requestClose()`, which asks; Cancel leaves both panels exactly as they
    were.

    RED FIRST, MEASURED: `menu.js`'s `closeOtherPanelsThen` had
    `askers[i].requestClose(...)` replaced with
    `askers[i].close(); next(i + 1);` (the force-close, skipping the
    question). Result: `asked=False`, `tuner still open=False`,
    `theme opened=True`, `dirty rows=0` -- the tuner panel closed and its
    dirty `bodyOpacity` change vanished silently on the very first click,
    before Cancel was ever offered, which is the exact bug the real fix
    (routing through `requestClose`) exists to prevent. Restored and re-run
    clean before this file was finished."""
    close_any_open_panel(page)
    page.wait_for_timeout(250)

    opened_tuner = open_menu_and_click(page, "settings", cx, cy)
    page.wait_for_timeout(400)
    if not opened_tuner or not page.evaluate("() => !!document.querySelector('.tuner-panel')"):
        return report("2: opening the theme panel asks before closing a dirty "
                      "tuning panel", False, "could not open the tuning panel")

    base = read_live(page, "arcs.bodyOpacity")
    out = page.evaluate("""async (target) => {
      const t = await import('./js/tuner.js');
      const idx = t.tunerRows().findIndex((r) => r.path === 'arcs.bodyOpacity');
      const rows = document.querySelectorAll('.tuner-row');
      const range = rows[idx].querySelector('.tuner-range');
      range.value = String(target);
      range.dispatchEvent(new Event('input', {bubbles: true}));
      return true;
    }""", 0.6)
    page.wait_for_timeout(150)
    moved = read_live(page, "arcs.bodyOpacity")

    # Cancel first: the theme panel must NOT open, and the tuner must still
    # be dirty with the moved value.
    clicked = open_menu_and_click(page, "theme", cx, cy)
    page.wait_for_timeout(300)
    asked = confirm_state(page)
    asked_ok = confirm_is_really_open(asked) and asked.get("yes") and asked.get("no")
    canceled = answer_confirm(page, False)
    page.wait_for_timeout(400)
    after_cancel = {
        "tuner": panel_is_really_open(page.evaluate("""() => {
          const el = document.querySelector('.tuner-panel:not(.theme-panel)');
          if (!el) return {present: false};
          const r = el.getBoundingClientRect();
          return {present: true, inDocument: document.contains(el),
                  w: r.width, h: r.height};
        }""")),
        "theme": panel_is_really_open(theme_panel_state(page)),
        "live": read_live(page, "arcs.bodyOpacity"),
        "dirty": page.evaluate(
            "() => document.querySelectorAll('.tuner-row.tuner-dirty').length"),
    }
    cancel_ok = (asked_ok and canceled and after_cancel["tuner"]
                 and not after_cancel["theme"]
                 and abs((after_cancel["live"] or 0) - 0.6) < 1e-9
                 and after_cancel["dirty"] >= 1)

    # Then confirmed: the tuner closes (reverting), and the theme panel opens.
    clicked2 = open_menu_and_click(page, "theme", cx, cy)
    page.wait_for_timeout(300)
    asked2 = confirm_is_really_open(confirm_state(page))
    answered2 = answer_confirm(page, True) if asked2 else False
    page.wait_for_timeout(500)
    after = {
        "tuner": page.evaluate("() => !!document.querySelector('.tuner-panel:not(.theme-panel)')"),
        "theme": panel_is_really_open(theme_panel_state(page)),
        "live": read_live(page, "arcs.bodyOpacity"),
    }
    through_ok = (clicked2 and asked2 and answered2 and not after["tuner"]
                  and after["theme"] and abs((after["live"] or 0) - base) < 1e-9)

    close_any_open_panel(page)
    ok = (opened_tuner and abs(moved - 0.6) < 1e-9 and moved != base
          and cancel_ok and through_ok)
    return report(
        "2: opening the theme panel asks before closing a dirty tuning panel, "
        "and Cancel leaves both alone", ok,
        f"bodyOpacity base={base} -> drag {moved}; Cancel: asked={asked_ok} "
        f"tuner still open={after_cancel['tuner']} theme opened="
        f"{after_cancel['theme']} live still {after_cancel['live']} dirty rows="
        f"{after_cancel['dirty']} (ok={cancel_ok}); confirmed: tuner gone="
        f"{not after['tuner']} theme open={after['theme']} live -> "
        f"{after['live']} (ok={through_ok})")


def case3_presets_recolor(page, cx, cy) -> bool:
    """3: each of the five presets really recolors the globe, and no two
    presets are secretly the same ramp.

    Samples a box centered on the canvas (always where the sphere sits --
    the camera looks at the globe's own origin every frame) and a box in the
    canvas's top-right corner (empty sky, far from the panel on the left).
    The sky box's lower `val` against the globe box's is the proof the globe
    box is really on the disc. The metric is a mean-RGB EUCLIDEAN DISTANCE
    between two settled averages, checked over EVERY pair of the 5 presets
    (10 pairs), not a hue delta: measured live, aggregating a dozen
    differently-t elements plus arcs and bloom into one region makes some
    ramp pairs (magma/inferno/cividis, which share a warm dark-to-light
    character across most of their range -- magma and inferno genuinely so,
    see below) land close in raw hue, and hue
    itself is numerically unstable at the low saturation cividis produces --
    a small RGB shift swings it by tens of degrees for no real reason. RGB
    distance has neither problem and is exactly what "visibly different"
    means for two flat colors. Not a golden image -- two frames of the live
    synthetic feed never match -- the bar is a real distance between
    independently-sampled averages, not a match against a stored picture.

    THE ARCS ARE SUPPRESSED FOR THE SAMPLE, and that is the whole of what
    makes this case reliable -- see CASE3_QUIET_FLOWS' comment for the
    before/after measurement. Rate to its schema floor, pool cleared before
    every shot, both restored afterward. The globe box otherwise catches
    whatever arcs are in flight at the instant of the screenshot, which is
    Poisson-driven and the brightest thing in the frame: measured, that noise
    was 2.97 against a closest real pair of 3.23, so the metric was reading
    mostly arcs. Suppressed, the same-preset ceiling is 0.08.

    RED FIRST, MEASURED, against the CURRENT RGB-distance metric (an earlier
    hue-delta version of this case was separately broken and restored during
    an even earlier draft; that evidence no longer applies to this metric
    and was replaced by this one rather than left standing in for it).

    The lever used was the one the metric itself validates against: with
    `PRESET_IDS` collapsed to `['plasma'] * 5` (every "preset" the same
    value -- the observable effect of a no-op `setActiveRamp`, with no
    source file touched or restored), this case's own sampling and
    assertion logic ran unmodified and produced:
      `closest pair ('plasma', 'plasma') dist=0.00 (min required 4.0, ...
      all distinguishable=False)`, `case3 result: False`.
    `brightness sanity` still passed (the globe box was still brighter than
    the sky box -- that half of the check does not depend on the ramp
    varying at all, which is why it survives as a second guard even here).

    WHAT THIS CASE DOES NOT CLAIM. magma and inferno render this region
    0.87 apart -- one part in 255, invisible. They are near-twin ramps and
    the globe box is dominated by the low-t elements where they agree most.
    So this case asserts that every preset REACHES the globe and that no two
    are secretly the same ramp; it does not assert that any two are telling
    apart by eye, because for that pair it would be false. The 5.08 this
    file once recorded for magma/inferno was arc noise, not separation."""
    ok_open = open_theme_panel(page, cx, cy)
    if not ok_open:
        return report("3: each preset really recolors the globe", False,
                      "could not open the panel")

    page.wait_for_timeout(CASE3_WARMUP_SECONDS * 1000)

    # Read the live rate back BEFORE lowering it, and put it back in the
    # `finally` below whatever happens -- an early return or an exception
    # inside the sampling loop must not leave the wall running at one flow a
    # second with nobody told why.
    original_flows = read_live(page, "traffic.flowsPerSecond")
    globe_box, sky_box = canvas_regions(page)
    samples = {}
    try:
        page.evaluate("(n) => window.__netviz.settings.apply("
                      "{'traffic.flowsPerSecond': n})", CASE3_QUIET_FLOWS)
        for preset_id in PRESET_IDS:
            set_preset(page, preset_id)
            page.wait_for_timeout(CASE3_SETTLE_MS)
            # Cleared per preset, not once: the pool refills even at the floor
            # rate, and a shot taken later in the sweep would carry more arcs
            # than one taken early -- which is a drift across the very sequence
            # being compared, the same shape of error the old 30s warmup was
            # fighting.
            page.evaluate("() => window.__netviz.arcs.rebuild()")
            page.wait_for_timeout(CASE3_QUIET_SETTLE_MS)
            g = sample_region_averaged(page, globe_box, CASE3_SAMPLES,
                                       CASE3_SAMPLE_GAP_MS)
            s = sample_mean_rgb(page, sky_box)
            samples[preset_id] = (g, s)
    finally:
        if isinstance(original_flows, (int, float)):
            page.evaluate("(n) => window.__netviz.settings.apply("
                          "{'traffic.flowsPerSecond': n})", original_flows)

    # Restore before asserting, so a failure does not leave the wall on a
    # random preset -- pendingPaths is just {appearance.theme} here, since no
    # element was touched.
    if page.evaluate("() => { const b = document.querySelector('.tuner-revert'); "
                     "return !!b && !b.disabled; }"):
        click_and_confirm(page, ".tuner-revert")
    close_any_open_panel(page)

    brightness_ok = all(
        rgb_to_hsv255(g)["val"] - rgb_to_hsv255(s)["val"] > CASE3_VAL_MARGIN
        for g, s in samples.values())
    pairs = [(a, b) for i, a in enumerate(PRESET_IDS) for b in PRESET_IDS[i + 1:]]
    distances = {(a, b): rgb_distance(samples[a][0], samples[b][0]) for a, b in pairs}
    moved = all(d >= CASE3_RGB_DIST_MIN for d in distances.values())
    ok = bool(brightness_ok and moved)
    worst = min(distances.items(), key=lambda kv: kv[1])
    detail = "; ".join(
        f"{pid}: globe rgb=({g[0]:.1f},{g[1]:.1f},{g[2]:.1f}) hue={rgb_to_hsv255(g)['hue']:.1f} "
        f"val={rgb_to_hsv255(g)['val']:.3f}, sky val={rgb_to_hsv255(s)['val']:.3f}"
        for pid, (g, s) in samples.items())
    return report(
        "3: each preset really recolors the globe", ok,
        f"{detail}; closest pair {worst[0]} dist={worst[1]:.2f} (min required "
        f"{CASE3_RGB_DIST_MIN}, {len(pairs)} pairs checked, all distinguishable="
        f"{moved}); brightness sanity (globe val > sky val by "
        f"{CASE3_VAL_MARGIN})={brightness_ok}")


def case4_override_survives_auto_does_not(page, cx, cy) -> bool:
    """4: an overridden element survives a theme change; an `auto` element
    does not.

    Two rows, both starting `auto` on plasma: OVERRIDE_KEY gets an explicit
    hex, AUTO_KEY is left alone. Switching the theme must hold the first
    row's swatch at the exact hex it was given and move the second row's
    swatch to `resolveColor(AUTO_KEY, 'auto')` under the NEW theme -- read
    from the page's own function, never recomputed here.

    FOUND RED, NOW GREEN -- this case was written against the spec rather
    than against the code, and on first run it failed: the auto row's swatch
    did NOT move when the preset was switched from the panel's own selector.
    Traced to `theme_panel.js`'s `syncRow()`: on `THEME_PATH` or `RAMP_PATH`
    it called `syncPreset()`/`syncGradient()` only and never re-synced any of
    the twelve element rows, so an `auto` row's on-screen swatch went stale
    until the panel was closed and reopened -- even though `resolveColor()`
    and the actual wall (via `applyTheme`'s fan-out in `js/apply.js`) were
    both correct the whole time. Fixed in `dfef972` (theme panel: re-sync
    every auto row when the ramp moves); this case now passes against the
    shipped tree and stands as the regression guard for that fix. The
    override half of this same case (does the overridden row hold its exact
    hex) passed throughout, which is the point of testing both halves
    together: a version of this case that only checked the override would
    have reported the panel healthy while this bug sat in it."""
    keys = element_keys(page)
    OVERRIDE_KEY, AUTO_KEY = "coastline", "admin1"
    oi, ai = keys.index(OVERRIDE_KEY), keys.index(AUTO_KEY)
    reset_theme_defaults(page, keys)
    if not open_theme_panel(page, cx, cy):
        return report("4: an override survives a theme change, an auto "
                      "element does not", False, "could not open the panel")

    override_hex = "#336699"
    set_element_color(page, oi, override_hex)
    page.wait_for_timeout(150)
    before_override = element_row_state(page, oi)
    before_auto = element_row_state(page, ai)
    plasma_auto_color = resolve_color(page, AUTO_KEY)

    set_preset(page, "viridis")
    page.wait_for_timeout(400)
    after_override = element_row_state(page, oi)
    after_auto = element_row_state(page, ai)
    viridis_auto_color = resolve_color(page, AUTO_KEY)

    close_any_open_panel(page)

    override_survived = (before_override["colorValue"].lower() == override_hex
                          and after_override["colorValue"].lower() == override_hex
                          and after_override["dirty"])
    auto_moved = (before_auto["hexText"] == "auto" and after_auto["hexText"] == "auto"
                  and plasma_auto_color != viridis_auto_color
                  and after_auto["colorValue"].lower() == viridis_auto_color.lower()
                  and before_auto["colorValue"].lower() == plasma_auto_color.lower())
    ok = bool(override_survived and auto_moved)
    return report(
        "4: an override survives a theme change, an auto element does not", ok,
        f"{OVERRIDE_KEY} (override): {before_override['colorValue']} -> "
        f"{after_override['colorValue']} (held={override_survived}); "
        f"{AUTO_KEY} (auto): {before_auto['colorValue']} ({plasma_auto_color} "
        f"expected) -> {after_auto['colorValue']} ({viridis_auto_color} "
        f"expected) (tracked the theme={auto_moved})")


def case5_revert_el_returns_to_theme(page, cx, cy) -> bool:
    """5: the per-row `↺` returns one overridden element to the theme's
    color and no other.

    RED FIRST, MEASURED: `theme_panel.js`'s `resetElement` was changed to
    `function resetElement(key) { return true; }` (a no-op). Result: the
    color value read back `#aa5500`/`#aa5500` -> `#aa5500`/`#aa5500`
    (unchanged) against the theme color `#7a05a6` this case expected --
    `after['colorValue']` never left the override and `.tuner-hex` never
    flipped back to the literal string `'auto'`, both checked here so a fix
    that only touched one of the two would still be caught. Restored and
    re-run clean before this file was finished."""
    keys = element_keys(page)
    KEY = "bordersWorld"
    idx = keys.index(KEY)
    reset_theme_defaults(page, keys)
    if not open_theme_panel(page, cx, cy):
        return report("5: the per-row undo returns one element to the theme "
                      "color", False, "could not open the panel")

    theme_color = resolve_color(page, KEY)
    override_hex = "#aa5500"
    set_element_color(page, idx, override_hex)
    page.wait_for_timeout(150)
    overridden = element_row_state(page, idx)

    clicked = click_revert_el(page, idx)
    page.wait_for_timeout(200)
    after = element_row_state(page, idx)

    close_any_open_panel(page)

    ok = (clicked and overridden["colorValue"].lower() == override_hex
          and overridden["hexText"] == override_hex
          and after["colorValue"].lower() == theme_color.lower()
          and after["hexText"] == "auto")
    return report(
        "5: the per-row undo returns one element to the theme color", ok,
        f"{KEY}: override {overridden['colorValue']!r}/{overridden['hexText']!r} "
        f"-> after undo {after['colorValue']!r}/{after['hexText']!r} "
        f"(theme color expected {theme_color})")


def _first_int(text):
    """The first integer in a piece of UI copy, or None.

    The footer reads "N settings changed, not yet kept" and the dialog title
    "Close and discard N changes?" -- this case compares those two numbers
    against each other rather than against a constant, so the roller can grow
    without the verifier going red on a healthy build."""
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else None


def case6_chaos_then_close_asks(page, cx, cy) -> bool:
    """6: Chaos marks every element row dirty and asks nothing; Close, now
    facing everything Chaos rolled, DOES ask, and Yes discards all of it.

    THE PENDING COUNT IS NOT TWELVE AND MUST NOT BE HARDCODED. Chaos rolls
    more than the twelve element rows -- the arc colors, the surface tints
    and the atmosphere numbers have no row on this panel but are snapshotted
    and reverted with everything else (see `allPaths()` unioning in
    `CHAOS_PATHS`). This case asserted `"12" in count_text` and went red the
    day the roller grew, reporting a working build as broken: the literal
    encoded one release's arithmetic rather than the property. What is
    actually required is that the three readings AGREE -- the marked rows,
    the footer's count and the dialog's count all describe the same pending
    state -- and that the footer's number is at least the number of rows,
    since every row Chaos marks is also pending.

    RED FIRST, MEASURED: `theme_panel.js`'s `closeQuestion` was changed to
    unconditionally `return null;` (the question never fires, whatever is
    pending). Result: `asked=False`, `title=None`, `answered=False` -- the
    panel closed on the very first Close click with twelve unkept colors
    silently discarded and no dialog ever drawn -- while the Chaos half
    (`dirty rows=12/12`, `no dialog from chaos=True`) still read exactly as
    it does against working code, which is why both halves live in one
    case: a version that checked only Chaos would report this build
    healthy. Restored and re-run clean before this file was finished."""
    keys = element_keys(page)
    reset_theme_defaults(page, keys)
    if not open_theme_panel(page, cx, cy):
        return report("6: Chaos dirties every row, and Close then asks", False,
                      "could not open the panel")

    preset_before = page.evaluate("() => document.querySelector('.theme-preset').value")
    clicked = click_panel_button(page, ".theme-chaos")
    page.wait_for_timeout(300)
    no_dialog = not confirm_is_really_open(confirm_state(page))
    dirty_count = page.evaluate(
        "() => document.querySelectorAll('.theme-row.tuner-dirty').length")
    preset_after = page.evaluate("() => document.querySelector('.theme-preset').value")
    count_text = page.evaluate(
        "() => (document.querySelector('.tuner-count') || {}).textContent || ''")

    clicked_close, asked, answered, cstate = click_and_confirm(page, ".tuner-close")
    page.wait_for_timeout(300)
    gone = not page.evaluate("() => !!document.querySelector('.theme-panel')")

    # Derived, not literal: pull the count the panel printed and the count
    # the dialog printed, and require them to agree with each other and to
    # cover every marked row.
    footer_n = _first_int(count_text)
    dialog_n = _first_int(cstate.get("title") or "")
    counts_agree = (footer_n is not None and footer_n == dialog_n
                    and footer_n >= dirty_count)

    ok = (clicked and no_dialog and dirty_count == len(keys)
          and preset_after == preset_before and counts_agree
          and clicked_close and asked and answered and gone)
    return report(
        "6: Chaos dirties every row and asks nothing, Close then asks", ok,
        f"chaos clicked={clicked} no dialog from chaos={no_dialog} dirty "
        f"rows={dirty_count}/{len(keys)} preset unchanged={preset_after == preset_before} "
        f"({preset_before!r} -> {preset_after!r}) footer={count_text!r} "
        f"(footer={footer_n} dialog={dialog_n} agree={counts_agree}); Close "
        f"asked={asked} (title={cstate.get('title')!r}) answered={answered} "
        f"panel gone={gone}")


def case7_background_refused_under_new_cap(page, cx, cy) -> bool:
    """7: a background legal under one theme's derived cap can become
    illegal under a stricter one; the write is refused with a reason naming
    the measured luminance and the cap, and the sky is left untouched.

    `appearance.background` is not a theme-panel row -- see settings.js and
    tuner.js -- so this drives `window.__netviz.settings.apply()` directly,
    the one case in this file that does not go through either panel's own
    DOM, because the interaction under test is between the schema's derived
    cap and the active ramp, not any control's wiring.

    #141414 (L=0.0070) sits under plasma's cap (0.0088) and viridis's
    (0.0107) but over magma's (0.0050) and inferno's (0.0049) -- computed
    from `maxBackgroundLuminance()`'s own formula, not eyeballed.

    RED FIRST, MEASURED: `settings.js`'s `coerce` had its `if (L > cap)`
    replaced with `if (false)` for the color branch (the luminance check
    never fires). Result: the re-write under magma came back
    `rejected=[]`, `refused=False` -- the wall went over its own derived
    cap with the control reporting success, while the earlier write under
    plasma and the sky-holds check were unaffected (that path never reaches
    the broken branch). Restored and re-run clean before this file was
    finished."""
    keys = element_keys(page)
    reset_theme_defaults(page, keys)
    original_store = read_store(page)

    LEGAL_HEX = "#141414"        # L=0.0070
    try:
        out1 = page.evaluate(
            "(v) => window.__netviz.settings.apply({'appearance.background': v})",
            LEGAL_HEX)
        page.wait_for_timeout(150)
        sky_after_legal = page.evaluate(
            "() => '#' + window.__netviz.scene.background.getHexString()")

        page.evaluate(
            "() => window.__netviz.settings.apply({'appearance.theme': 'magma'})")
        page.wait_for_timeout(150)
        sky_after_theme = page.evaluate(
            "() => '#' + window.__netviz.scene.background.getHexString()")

        out2 = page.evaluate(
            "(v) => window.__netviz.settings.apply({'appearance.background': v})",
            LEGAL_HEX)
        page.wait_for_timeout(150)
        sky_after_refusal = page.evaluate(
            "() => '#' + window.__netviz.scene.background.getHexString()")
    finally:
        page.evaluate(
            "() => window.__netviz.settings.apply({'appearance.background': 'auto', "
            "'appearance.theme': 'plasma'})")
        page.wait_for_timeout(150)
        restore_store(page, original_store)

    accepted_under_plasma = (out1.get("applied") == ["appearance.background"]
                              and not out1.get("rejected"))
    held_across_theme_switch = sky_after_legal == sky_after_theme == LEGAL_HEX
    rejected = out2.get("rejected") or []
    refused = (bool(rejected) and rejected[0]["path"] == "appearance.background"
               and "luminance" in rejected[0]["why"] and "cap" in rejected[0]["why"])
    sky_unchanged = sky_after_refusal == sky_after_theme

    ok = bool(accepted_under_plasma and held_across_theme_switch and refused
              and sky_unchanged)
    return report(
        "7: a background illegal under the active theme's cap is refused "
        "with a reason, and the sky holds", ok,
        f"accepted under plasma={accepted_under_plasma} ({out1}); sky after "
        f"legal write={sky_after_legal}, after switching to magma (no "
        f"re-write)={sky_after_theme} (held={held_across_theme_switch}); "
        f"re-write under magma rejected={rejected} (refused={refused}); sky "
        f"after the refused write={sky_after_refusal} (unchanged={sky_unchanged})")


def case8_stop_edit_forks_then_restores(page, cx, cy) -> bool:
    """8: editing a gradient stop forks the active preset to `custom`;
    picking the preset back restores its original ten stops exactly, and the
    forked array is still sitting in `appearance.customRamp`, unerased.

    RED FIRST, MEASURED: `theme_panel.js`'s `setStop` was made a no-op
    (`return;` right after computing `stops`, before ever calling
    `writePatch`). Result: `preset before=plasma -> after stop edit=plasma`
    (`forked=False` -- it never reached `'custom'`), and, further down,
    `customRamp untouched by the re-pick=False`, because with `setStop`
    dead the array in `appearance.customRamp` never received the edited
    stop in the first place -- both halves caught the same break from two
    different angles. Restored and re-run clean before this file was
    finished."""
    keys = element_keys(page)
    reset_theme_defaults(page, keys)
    if not open_theme_panel(page, cx, cy):
        return report("8: editing a stop forks to custom, re-picking the "
                      "preset restores it intact", False, "could not open the panel")

    original_stops = gradient_stops(page)
    preset_before = page.evaluate("() => document.querySelector('.theme-preset').value")

    EDIT_HEX = "#00ffaa"
    set_gradient_stop(page, 3, EDIT_HEX)
    page.wait_for_timeout(200)
    forked_preset = page.evaluate("() => document.querySelector('.theme-preset').value")
    forked_stops = gradient_stops(page)
    forked_ramp_live = read_live(page, "appearance.customRamp")

    set_preset(page, "plasma")
    page.wait_for_timeout(300)
    restored_preset = page.evaluate("() => document.querySelector('.theme-preset').value")
    restored_stops = gradient_stops(page)
    ramp_after_restore = read_live(page, "appearance.customRamp")

    close_any_open_panel(page)

    forked = (preset_before == "plasma" and forked_preset == "custom"
              and forked_stops[3].lower() == EDIT_HEX
              and forked_stops != original_stops)
    intact = restored_preset == "plasma" and restored_stops == original_stops
    # The custom array is not erased by re-picking a preset -- only
    # `appearance.theme` is written when a name is selected off the list.
    edit_preserved = (ramp_after_restore == forked_ramp_live
                       and ramp_after_restore[3].lower() == EDIT_HEX)
    ok = bool(forked and intact and edit_preserved)
    return report(
        "8: editing a stop forks to custom, re-picking the preset restores "
        "it intact", ok,
        f"preset before={preset_before} -> after stop edit={forked_preset} "
        f"(forked={forked}) -> after re-picking plasma={restored_preset} "
        f"(stops match original={restored_stops == original_stops}, "
        f"intact={intact}); customRamp untouched by the re-pick="
        f"{edit_preserved} (still holds the edited stop 3={ramp_after_restore[3] if ramp_after_restore else None})")


# --------------------------------------------------------------------- run --

def run(page, cx, cy) -> bool:
    ok = True
    ok &= case1_geometry(page, cx, cy)
    ok &= case2_closes_tuner_first(page, cx, cy)
    ok &= case3_presets_recolor(page, cx, cy)
    ok &= case4_override_survives_auto_does_not(page, cx, cy)
    ok &= case5_revert_el_returns_to_theme(page, cx, cy)
    ok &= case6_chaos_then_close_asks(page, cx, cy)
    ok &= case7_background_refused_under_new_cap(page, cx, cy)
    ok &= case8_stop_edit_forks_then_restores(page, cx, cy)
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
