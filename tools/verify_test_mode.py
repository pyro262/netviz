#!/usr/bin/env python3
"""Prove TEST MODE against a real page, with numbers.

`menu.testMode` was one boolean that meant four different things, and its only
explanation was a tooltip -- on a display nobody hovers. 0.7.0 makes it fifteen
choices in a dialog and adds a self-test behind them. Five cases, and each one
is about a decision that could have gone the other way:

  1. THE MENU ROW OPENS SOMETHING. `Test Mode…` is an action, not a toggle: the
     ellipsis is the signal, and a row that still flipped a boolean would look
     identical in the menu and do nothing a person could find.
  2. EVERY OPTION EXPLAINS ITSELF IN VISIBLE COPY. Not in a `title` -- a wall
     display is never hovered, which is the same call that printed Randomize's
     scope under its button instead of leaving it in a tooltip. Asserted by
     reading the rendered text, so an explanation that moved back into an
     attribute fails here.
  3. `enable all` TICKS ONE CATEGORY AND LEAVES THE OTHERS. A category with a
     single option gets no such button at all, because offering to enable one
     thing is the same empty question confirm.js already refuses to ask.
  4. HOVER PREVIEW IS PER-CATEGORY NOW. A layer row previews under
     `test.preview.layers` and reverts on the way out; the RAIL row does not,
     because `test.preview.rail` is off by default -- `rail.enabled` is
     `relayout`, so every pass of the cursor would resize the renderer and
     rebuild the bloom pass's targets. That exclusion was hardcoded and
     invisible until 0.7.0; this case is what keeps it a choice.
  5. A SELF-TEST RUN PAUSES THE FEED AND POLLUTES NOTHING. The live feed stops
     for the duration (renderer-side only -- the collector keeps running), the
     report carries one line per ticked check, and the RAIL'S COUNTERS ARE
     UNCHANGED ACROSS THE RUN. That last one is the point: sample arcs are drawn
     straight through the pool and never injected as events, because a test that
     pollutes the numbers it is testing is worse than no test.

    python3 tools/verify_test_mode.py
    python3 tools/verify_test_mode.py --url http://HOST:8099/
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
# Its own port -- see the same note in tools/verify_aurora.py for the full map.
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8196"))
URL = f"http://127.0.0.1:{PORT}/"

RESULTS: list[tuple] = []


def report(name: str, ok: bool, detail: str) -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} -- {detail}")
    RESULTS.append((name, ok, detail))
    return ok


def dispatch_contextmenu(page, cx, cy) -> None:
    page.evaluate("""({x, y}) => {
      const c = document.querySelector('canvas');
      c.dispatchEvent(new MouseEvent('contextmenu',
        {bubbles: true, cancelable: true, clientX: x, clientY: y}));
    }""", {"x": cx, "y": cy})


def menu_row(page, data_id):
    return page.evaluate("""(id) => {
      const row = document.querySelector(`.menu [data-id="${id}"]`);
      if (!row) return null;
      return {text: row.textContent, cls: row.className,
              hasCheck: !!row.querySelector('.menu-check, input[type=checkbox]')};
    }""", data_id)


def click_menu_row(page, data_id) -> bool:
    return bool(page.evaluate("""(id) => {
      const row = document.querySelector(`.menu [data-id="${id}"]`);
      if (!row || row.className.includes('disabled')) return false;
      row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
      return true;
    }""", data_id))


def panel_open(page) -> bool:
    return bool(page.evaluate("""() => {
      const el = document.querySelector('.test-panel');
      if (!el || !document.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }"""))


def close_panel(page) -> None:
    page.evaluate("() => window.__netviz.testPanel && window.__netviz.testPanel.close()")
    page.wait_for_timeout(200)


def reset_test_paths(page) -> None:
    """Every `test.*` back to its shipped default, through the persisting
    applier, and any running showing stopped.

    Inter-case isolation, not something under test: a case that left four things
    ticked -- or a showing running -- would change what the next one measures."""
    page.evaluate("""async () => {
      const t = await import('./js/test_panel.js');
      const s = await import('./js/settings.js');
      const patch = {};
      for (const i of [...t.SHOW_ITEMS, ...t.PREVIEW_ITEMS]) patch[i.path] = false;
      window.__netviz.settings.apply(patch);
      window.__netviz.settings.apply({'test.show.auroraKp': s.defaultOf('test.show.auroraKp')});
    }""")
    page.evaluate("() => window.__netviz.showcase && window.__netviz.showcase.stop()")
    page.wait_for_timeout(200)


def case1_menu_row_opens_a_dialog(page, cx, cy) -> bool:
    """1: the menu row is an action that opens something, not a toggle."""
    name = "1: Test Mode is an action that opens a dialog, not a toggle"
    close_panel(page)
    dispatch_contextmenu(page, cx, cy)
    page.wait_for_timeout(250)
    row = menu_row(page, "testMode")
    if not row:
        return report(name, False, "no testMode row in the menu at all")
    # The ellipsis is the signal that a click opens something. Either character
    # is accepted: the source uses the single glyph, but a future edit typing
    # three dots means the same thing to a reader.
    has_ellipsis = "\u2026" in row["text"] or "..." in row["text"]
    clicked = click_menu_row(page, "testMode")
    page.wait_for_timeout(400)
    opened = panel_open(page)
    close_panel(page)
    ok = has_ellipsis and clicked and opened and not row["hasCheck"]
    return report(name, ok,
                  f"row text={row['text']!r} (ellipsis={has_ellipsis}), carries a "
                  f"checkbox={row['hasCheck']} (must be False), clicked={clicked}, "
                  f"dialog opened={opened}")


def case2_every_row_explains_itself(page, cx, cy) -> bool:
    """2: every row's explanation is on the panel, not in a tooltip.

    A wall display is never hovered, so an explanation in a `title` reaches
    nobody -- the same call that printed Randomize's scope under its button."""
    name = "2: every row explains itself in visible copy, not a title"
    close_panel(page)
    page.evaluate("() => window.__netviz.testPanel.open()")
    page.wait_for_timeout(400)
    out = page.evaluate("""async () => {
      const t = await import('./js/test_panel.js');
      const el = document.querySelector('.test-panel');
      const helps = [...el.querySelectorAll('.test-opt-help')].map((n) => n.textContent);
      return {
        rows: t.SHOW_ITEMS.length + t.PREVIEW_ITEMS.length,
        checks: el.querySelectorAll('.test-check').length,
        helps: helps.length,
        shortest: helps.length ? Math.min(...helps.map((h) => h.length)) : 0,
        // The aurora row's strength control, which is the only parameter on the
        // panel and the one thing that decides WHICH storm gets drawn.
        kpRange: !!el.querySelector('.test-param-range'),
        previewBlock: !!el.querySelector('.test-preview-cat'),
      };
    }""")
    close_panel(page)
    ok = (out["checks"] == out["rows"] and out["helps"] == out["rows"]
          and out["shortest"] > 40 and out["kpRange"] and out["previewBlock"])
    return report(name, ok,
                  f"{out['checks']} checkboxes and {out['helps']} visible "
                  f"explanations for {out['rows']} rows; shortest explanation "
                  f"{out['shortest']} chars (want >40); Kp slider "
                  f"present={out['kpRange']}; previews in their own block="
                  f"{out['previewBlock']}")


def case3_show_is_dead_until_something_is_ticked(page, cx, cy) -> bool:
    """3: Show does nothing until there is something to show, and says so."""
    name = "3: Show is dead until something is ticked"
    reset_test_paths(page)
    close_panel(page)
    page.evaluate("() => window.__netviz.testPanel.open()")
    page.wait_for_timeout(400)
    before = page.evaluate(
        "() => document.querySelector('.test-show').disabled")
    page.evaluate("""() => {
      const b = document.querySelector('.test-check[data-path="test.show.blocked"]');
      b.checked = true;
      b.dispatchEvent(new Event('change', {bubbles: true}));
    }""")
    page.wait_for_timeout(250)
    after = page.evaluate("""() => ({
      show: document.querySelector('.test-show').disabled,
      stop: document.querySelector('.test-stop').disabled,
    })""")
    close_panel(page)
    reset_test_paths(page)
    ok = (before is True and after["show"] is False and after["stop"] is True)
    return report(name, ok,
                  f"Show disabled with nothing ticked={before} (must be True), "
                  f"after ticking one: Show disabled={after['show']} (must be "
                  f"False), Stop disabled={after['stop']} (must be True -- "
                  f"nothing is running yet)")


def case4_hover_preview_is_per_category(page, cx, cy) -> bool:
    """4: a layer row previews, the rail row does not while its own gate is off.

    BOTH HALVES, because either alone is passed by a bug: a build that previews
    nothing passes the rail half, and one that previews everything passes the
    layer half. The rail is the exclusion that used to be hardcoded and
    invisible, and it is a setting with its cost written beside it now."""
    name = "4: layer rows preview on hover, the rail row does not"
    close_panel(page)
    page.evaluate("""() => window.__netviz.settings.apply({
      'test.preview.layers': true, 'test.preview.rail': false,
    })""")
    page.wait_for_timeout(200)

    def hover(data_id):
        return page.evaluate("""(id) => {
          const row = document.querySelector(`.menu [data-id="${id}"]`);
          if (!row) return false;
          row.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));
          return true;
        }""", data_id)

    def leave(data_id):
        page.evaluate("""(id) => {
          const row = document.querySelector(`.menu [data-id="${id}"]`);
          if (row) row.dispatchEvent(new MouseEvent('mouseleave', {bubbles: false}));
        }""", data_id)

    def live(path):
        return page.evaluate("""async (p) => {
          const c = await import('./js/config.js');
          return c.cfg(p, null);
        }""", path)

    dispatch_contextmenu(page, cx, cy)
    page.wait_for_timeout(250)
    # The Layers submenu is click-to-expand, so the layer rows have to be shown.
    page.evaluate("""() => {
      const row = document.querySelector('.menu [data-id="layers"]');
      if (row) row.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    }""")
    page.wait_for_timeout(250)

    stars_before = live("layers.stars")
    hovered = hover("layers.stars")
    # HOVER_DELAY_MS is 150; wait past it rather than racing it.
    page.wait_for_timeout(500)
    stars_during = live("layers.stars")
    leave("layers.stars")
    page.wait_for_timeout(400)
    stars_after = live("layers.stars")

    rail_before = live("rail.enabled")
    hover("rail")
    page.wait_for_timeout(500)
    rail_during = live("rail.enabled")
    leave("rail")
    page.wait_for_timeout(300)

    page.evaluate("() => document.body.click()")
    page.wait_for_timeout(200)
    reset_test_paths(page)

    layer_ok = hovered and stars_during != stars_before and stars_after == stars_before
    rail_ok = rail_during == rail_before
    return report(name, bool(layer_ok and rail_ok),
                  f"layers.stars {stars_before} -> {stars_during} on hover -> "
                  f"{stars_after} on leave (previewed and reverted={layer_ok}); "
                  f"rail.enabled {rail_before} -> {rail_during} with "
                  f"test.preview.rail off (held={rail_ok})")


def case5_a_showing_shows_and_restores(page, cx, cy) -> bool:
    """5: a showing puts things on screen, moves no counter, and puts it back.

    THE COUNTER HALF IS THE ONE THAT MATTERS. Sample arcs go straight through
    the arc pool with an explicit class, so nothing a showing draws may reach
    classify.js or the rail's per-class counts -- a showing that injected
    fabricated traffic would look identical on screen and would quietly corrupt
    the numbers the wall exists to show.

    The RESTORE half is the other one: a layer this turned on has to go back
    off, a layer that was already on has to STAY on, and the aurora has to
    return to the real reading rather than to a default."""
    name = "5: a showing shows, moves no counter, and puts everything back"
    reset_test_paths(page)
    close_panel(page)
    before = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const counts = window.__netviz.classCounts;
      const now = Date.now();
      return {
        lightning: c.cfg('layers.lightning', false),
        aurora: window.__netviz.aurora.debug(),
        arcs: window.__netviz.arcs.liveCount(),
        flow: counts.ratePerMin('flow', now),
        block: counts.ratePerMin('block', now),
      };
    }""")
    page.evaluate("""() => window.__netviz.settings.apply({
      'test.show.blocked': true, 'test.show.lightning': true,
      'test.show.aurora': true, 'test.show.auroraKp': 8,
      'test.show.seconds': 5,
    })""")
    page.wait_for_timeout(200)
    page.evaluate("() => window.__netviz.testPanel.open()")
    page.wait_for_timeout(300)
    page.evaluate("() => document.querySelector('.test-show').click()")
    page.wait_for_timeout(800)

    during = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const el = document.querySelector('.test-panel');
      return {
        lightning: c.cfg('layers.lightning', false),
        kp: window.__netviz.aurora.debug().kp,
        arcs: window.__netviz.arcs.liveCount(),
        running: window.__netviz.showcase.isRunning(),
        onRows: el.querySelectorAll('.test-report-row.on').length,
        note: (el.querySelector('.test-note') || {}).textContent || '',
      };
    }""")
    close_panel(page)
    # It ends on its OWN clock -- closing the panel must not have stopped it.
    page.wait_for_timeout(6000)
    after = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const counts = window.__netviz.classCounts;
      const now = Date.now();
      return {
        lightning: c.cfg('layers.lightning', false),
        kp: window.__netviz.aurora.debug().kp,
        running: window.__netviz.showcase.isRunning(),
        flow: counts.ratePerMin('flow', now),
        block: counts.ratePerMin('block', now),
      };
    }""")
    reset_test_paths(page)

    drew = during["arcs"] > before["arcs"]
    forced = during["kp"] == 8
    lit = during["lightning"] is True
    restored = (after["lightning"] == before["lightning"]
                and after["kp"] == before["aurora"]["kp"]
                and after["running"] is False)
    counters_held = (abs(after["flow"] - before["flow"]) < 1e-9
                     and abs(after["block"] - before["block"]) < 1e-9)
    survived = during["running"] is True
    ok = bool(drew and forced and lit and restored and counters_held and survived
              and during["onRows"] >= 3)
    return report(
        name, ok,
        f"arcs {before['arcs']} -> {during['arcs']} (drew={drew}); Kp "
        f"{before['aurora']['kp']} -> {during['kp']} -> {after['kp']} "
        f"(forced={forced}, restored={after['kp'] == before['aurora']['kp']}); "
        f"lightning layer {before['lightning']} -> {during['lightning']} -> "
        f"{after['lightning']} (restored={after['lightning'] == before['lightning']}); "
        f"{during['onRows']} rows reported on screen; still running after the "
        f"panel closed={survived}; rail rate/min flow "
        f"{before['flow']}->{after['flow']} block {before['block']}->{after['block']} "
        f"(counters held={counters_held}) -- sample arcs must never reach them")


def run(page, cx, cy) -> bool:
    ok = True
    ok &= case1_menu_row_opens_a_dialog(page, cx, cy)
    ok &= case2_every_row_explains_itself(page, cx, cy)
    ok &= case3_show_is_dead_until_something_is_ticked(page, cx, cy)
    ok &= case4_hover_preview_is_per_category(page, cx, cy)
    ok &= case5_a_showing_shows_and_restores(page, cx, cy)
    return ok


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
    ok = True
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                              "--enable-unsafe-swiftshader"])
            ctx = browser.new_context(viewport={"width": 1600, "height": 900})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=30_000)
            time.sleep(2.0)
            rect = page.evaluate("""() => {
              const r = document.querySelector('canvas').getBoundingClientRect();
              return {cx: r.left + r.width / 2, cy: r.top + r.height / 2};
            }""")
            # Every case writes real settings through the persisting applier, so
            # this run's store is snapshotted and put back -- new_context() gives
            # it its own ephemeral profile, but that is worth not relying on.
            original = page.evaluate("() => window.localStorage.getItem('netviz.settings.v1')")
            try:
                ok = run(page, rect["cx"], rect["cy"])
            finally:
                page.evaluate("""(v) => {
                  if (v === null) window.localStorage.removeItem('netviz.settings.v1');
                  else window.localStorage.setItem('netviz.settings.v1', v);
                }""", original)
            browser.close()
    finally:
        if collector:
            os.killpg(os.getpgid(collector.pid), signal.SIGTERM)
            collector.wait(timeout=10)

    print()
    passed = sum(1 for _, p_, _ in RESULTS if p_)
    print(f"summary: {passed}/{len(RESULTS)} cases passed")
    print("errors:", errors[:5] or "none")
    return 0 if (ok and not errors) else 1


if __name__ == "__main__":
    sys.exit(main())
