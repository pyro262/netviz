#!/usr/bin/env python3
"""Prove the custom-arcs EDITOR against a real page.

`rules.js`'s arithmetic and `rulestore.js`'s pure half are proved under
`node --test`. What that cannot prove is the same gap `verify_rules.py`
exists for one layer down: that the PANEL a person actually clicks writes
through to arcs already on screen, survives a reload, and that the menu
opener really produces a document-attached element -- not just an object
that claims `isOpen()`. That split (an API's own claim vs. the element
actually being in the DOM with a non-zero rect) is exactly the bug that got
through a unit suite and a code review the same week for the menu itself;
this script holds the panel to the same standard.

`custom_arcs_panel.js` imports nothing from three, but it is driven entirely
through DOM nodes mounted by `main.js`'s real boot path, and `arcs.js`
itself imports three -- there is no local `node_modules` in this repo, so
none of this reaches under `node --test` at all. A real browser is the
only instrument.

    python3 tools/verify_rules_editor.py
    python3 tools/verify_rules_editor.py --url http://HOST:8099/
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
# Its own port: verify_rules.py owns 8499 and verify_menu.py shares it, so a
# port collision between two of these scripts run back to back is exactly
# the kind of thing that reads as a flaky test instead of the resource
# conflict it actually is.
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8599"))

# A cap, not a duration: case 7 stops as soon as all three country rules
# have real traffic and the rail has redrawn. Simulated browser time and
# the synthetic feed's own pace are not sized against each other, so
# nothing here assumes a fixed wall-clock duration will always be enough.
RULE_TRAFFIC_CAP_SECONDS = 45

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
    technique verify_menu.py uses rather than a Playwright button="right"
    click, so a right-click is driven identically everywhere in this repo."""
    return page.evaluate("""({x, y}) => {
      const canvas = document.querySelector('canvas');
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      });
      const notCanceled = canvas.dispatchEvent(ev);
      return !notCanceled;
    }""", {"x": x, "y": y})


def open_menu_and_click(page, data_id: str, cx: float, cy: float) -> bool:
    """Right-click the canvas, then click a `[data-id]` row. Returns whether
    the row was found and clicked -- callers assert on the visible effect,
    not on this return value alone, for the same reason verify_menu.py's
    case 10 does not trust a spy: a click that lands is not proof the row
    is wired to anything real."""
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


def panel_open_case(page, cx, cy) -> bool:
    """1: the panel really opens.

    The same split verify_menu.py's whole file is built around: the element
    must actually be `document.contains()`-true with a non-zero bounding
    rect, not merely `isOpen()` saying so."""
    page.evaluate("() => { const p = document.querySelector('.custom-arc-panel'); if (p) p.remove(); }")
    clicked = open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    state = page.evaluate("""() => {
      const el = document.querySelector('.custom-arc-panel');
      if (!el) return {present: false};
      const r = el.getBoundingClientRect();
      return {present: true, inDocument: document.contains(el), w: r.width, h: r.height};
    }""")
    ok = (clicked and state.get("present") and state.get("inDocument")
          and state.get("w", 0) > 0 and state.get("h", 0) > 0)
    return report("1: the panel really opens", ok, f"clicked={clicked} state={state}")


def live_recolor_case(page) -> bool:
    """2: typing recolors live arcs.

    The arc is spawned BEFORE the rule is typed, on purpose -- a rule that
    only reached arcs spawned later would still read as a dead control on
    the wall, the same reasoning verify_rules.py's case 1 documents. This
    also types more than one character with real `input` events and checks
    focus never leaves the field, the regression test for Task 3's
    patch-in-place fix: rebuilding every row on each keystroke would steal
    focus from under the person typing.

    Two things this repo's own state made non-obvious, both handled below:
    the synthetic collector migrates three NETVIZ_HIGHLIGHT* demo rules into
    `arcs.custom` before this panel ever opens (`rulesFromNetworks` in
    `config.js`), so the row this case adds is NOT at index 0 and the rule
    it becomes is NOT necessarily 'rule1' -- both are read back rather than
    assumed. And `arcs.spawn` rate-caps ordinary flows at
    `traffic.flowsPerSecond` against a real 1-second wall-clock window the
    background synthetic feed is also drawing from, so a single spawn call
    can be silently dropped; this retries across that window rather than
    treating one drop as a real failure.
    """
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const cl = await import('./js/classify.js');
      const ev = {k: 'flow', s: '203.0.113.9', d: '198.51.100.7',
                  sll: [-40, 150], dll: [-45, 160], b: 1000};

      // The synthetic feed keeps spawning ordinary 'flow' arcs in the
      // background, so filtering group.children by "shares flow's color"
      // would catch dozens of unrelated arcs, not just this one -- and only
      // ONE of them (ours) would move when the rule is installed, failing a
      // moved === live.length check for a reason that has nothing to do with
      // whether the control works. The pool is a fixed 220 Mesh objects
      // (arcs.js never creates or removes one), so diffing each mesh's
      // geometry uuid before/after spawn() -- synchronously, no await in
      // between, so nothing else can run on this single thread -- finds
      // exactly the one slot spawn() just wrote into, regardless of any
      // background traffic. Retried up to 2s (past the 1s rate-cap window)
      // in case this call itself loses the race for the shared budget.
      let live = [];
      const spawnDeadline = performance.now() + 2000;
      while (!live.length && performance.now() < spawnDeadline) {
        const before = arcs.group.children.map((m) => m.geometry.uuid);
        arcs.spawn(ev);
        live = arcs.group.children.filter((m, i) => m.geometry.uuid !== before[i]);
        if (!live.length) await new Promise((r) => setTimeout(r, 60));
      }
      if (!live.length) return {error: 'no arc slot changed on spawn after retrying'};

      const addBtn = document.querySelector('.custom-arc-add');
      if (!addBtn) return {error: 'no add-rule button -- is the panel open?'};
      const before = document.querySelectorAll('.custom-arc-row').length;
      addBtn.click();
      const rows = document.querySelectorAll('.custom-arc-row');
      if (rows.length !== before + 1) {
        return {error: `add did not append exactly one row (${before} -> ${rows.length})`};
      }
      const row = rows[rows.length - 1];           // the one just added, whatever its index
      const match = row.querySelector('.custom-arc-match');
      const color = row.querySelector('.custom-arc-color');
      match.focus();
      let acc = '';
      for (const ch of '203.0.113.0/24') {
        acc += ch;
        match.value = acc;
        match.dispatchEvent(new Event('input', {bubbles: true}));
      }
      const stillFocused = document.activeElement === match;
      color.value = '#ff00ff';
      color.dispatchEvent(new Event('input', {bubbles: true}));

      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 100));
      const cls = cl.classNameFor(ev);              // whichever rule slot this became
      const beforeHex = arcs.classColor('flow').getHex();
      const afterHex = arcs.classColor(cls) ? arcs.classColor(cls).getHex() : null;
      const moved = live.filter(
        (mesh) => mesh.material.uniforms.color.value.getHex() === afterHex).length;
      // Handed to case 3: which rule slot our rule became, and the address
      // that reaches it -- case 3 checks THIS rule survives an unrelated bad
      // row, not literally CONFIG.arcs.custom[0], because the synthetic
      // collector's own NETVIZ_HIGHLIGHT* migration already occupies index 0.
      if (cls !== 'flow' && afterHex !== null) window.__vreRule = {cls, ev};
      return {beforeHex, afterHex, moved, live: live.length, stillFocused, cls,
              ms: performance.now() - t0};
    }""")
    if result.get("error"):
        return report("2: typing recolors live arcs", False, result["error"])
    ok = (result["cls"] != "flow" and result["afterHex"] is not None
          and result["afterHex"] != result["beforeHex"]
          and result["moved"] == result["live"] and result["stillFocused"])
    return report(
        "2: typing recolors live arcs", ok,
        f"class {result['cls']}, {result['moved']}/{result['live']} live arcs moved "
        f"#{result['beforeHex']:06x} -> #{result['afterHex']:06x}, "
        f"stillFocused={result['stillFocused']}, {result['ms']:.0f}ms")


def bad_row_case(page) -> bool:
    """3: a bad row costs nothing.

    Adds another row with an unparseable matcher and asserts `.custom-arc-reason`
    shows on that row only, and that CASE 2'S RULE -- not literally
    `arcs.custom[0]`, which on this synthetic collector is already occupied by
    the NETVIZ_HIGHLIGHT* migration -- keeps coloring its arcs: an invalid
    row must not blank out a working one."""
    have_rule = page.evaluate("() => !!window.__vreRule")
    if not have_rule:
        return report("3: a bad row costs nothing", False,
                       "case 2 did not hand off a rule to check against")
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const cl = await import('./js/classify.js');
      const {cls, ev} = window.__vreRule;
      const goodRow = [...document.querySelectorAll('.custom-arc-row')].find(
        (r) => r.querySelector('.custom-arc-match').value === '203.0.113.0/24');

      const addBtn = document.querySelector('.custom-arc-add');
      const before = document.querySelectorAll('.custom-arc-row').length;
      addBtn.click();
      const rows = document.querySelectorAll('.custom-arc-row');
      if (rows.length !== before + 1) {
        return {error: `add did not append exactly one row (${before} -> ${rows.length})`};
      }
      const badRow = rows[rows.length - 1];
      const match = badRow.querySelector('.custom-arc-match');
      match.focus();
      match.value = 'nonsense';
      match.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 50));

      const badReason = badRow.querySelector('.custom-arc-reason');
      const goodReason = goodRow ? goodRow.querySelector('.custom-arc-reason') : null;

      const stillCls = cl.classNameFor(ev);
      const ruleHex = arcs.classColor(cls) ? arcs.classColor(cls).getHex() : null;
      // A FRESH arc, spawned after the bad row, must still take the rule's
      // color -- proving the bad row did not knock the good one out of the
      // compiled list, not just that the DOM still shows a swatch.
      // `arcs.spawn` rate-caps ordinary flows against a real 1-second window
      // the background synthetic feed is also drawing from, so a single call
      // can be silently dropped -- retry across that window, as case 2 does,
      // rather than reading one drop as a rule that stopped matching.
      let live = [];
      const spawnDeadline = performance.now() + 2000;
      while (!live.length && performance.now() < spawnDeadline) {
        const before2 = arcs.group.children.map((m) => m.geometry.uuid);
        arcs.spawn(ev);
        live = arcs.group.children.filter((m, i) => m.geometry.uuid !== before2[i]);
        if (!live.length) await new Promise((r) => setTimeout(r, 60));
      }
      const stillLive = live.filter(
        (m) => m.material.uniforms.color.value.getHex() === ruleHex).length;

      return {
        badHasReason: !!badReason, goodHasReason: !!goodReason, goodRowFound: !!goodRow,
        cls, stillCls, ruleHex, live: live.length, stillLive,
      };
    }""")
    if result.get("error"):
        return report("3: a bad row costs nothing", False, result["error"])
    ok = (result["badHasReason"] and result["goodRowFound"] and not result["goodHasReason"]
          and result["stillCls"] == result["cls"] and result["live"] > 0
          and result["stillLive"] == result["live"])
    return report(
        "3: a bad row costs nothing", ok,
        f"bad row reason={result['badHasReason']}, good row found={result['goodRowFound']}, "
        f"good row reason={result['goodHasReason']}, class still {result['stillCls']} "
        f"(was {result['cls']}), {result['stillLive']}/{result['live']} fresh arc(s) "
        f"still took its color")


def reload_survives_case(page) -> bool:
    """4: it survives a reload.

    Reloads the real page and checks CONFIG.arcs.custom still carries the
    rule, and that a fresh arc from the same address takes it -- proving
    the persisted patch, not just the in-memory CONFIG, is what survived."""
    page.reload(wait_until="load")
    page.wait_for_function("window.__netvizReady === true", timeout=20_000)
    page.wait_for_timeout(1500)
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      const rules = m.CONFIG.arcs.custom || [];
      const has = rules.some((r) => r.match === '203.0.113.0/24');
      const cl = await import('./js/classify.js');
      const cls = cl.classNameFor({k: 'flow', s: '203.0.113.9', d: '198.51.100.7'});
      return {rules, has, cls};
    }""")
    ok = result["has"] and result["cls"].startswith("rule")
    return report(
        "4: it survives a reload", ok,
        f"CONFIG.arcs.custom has the rule: {result['has']}, "
        f"a fresh arc classifies as {result['cls']}")


def export_import_roundtrip_case(page) -> bool:
    """5: export -> import round-trips.

    The OS file picker cannot be driven headlessly, so this proves the pure
    half that carries the risk: `serialiseRules`'s output, fed straight back
    through `parseImport`, must come back as the identical list. Read
    through the module directly, exactly as the brief specifies -- this is
    NOT going through the panel's own Export/Import buttons."""
    result = page.evaluate("""async () => {
      const rs = await import('./js/rulestore.js');
      const rules = [
        {match: '203.0.113.0/24', end: 'either', color: '#ff00ff', name: 'doc-net', enabled: true},
        {match: 'DE', end: 'either', color: '#22d3ee', name: '', enabled: false},
      ];
      const text = rs.serialiseRules(rules);
      const out = rs.parseImport(text);
      return {text, out, matches: JSON.stringify(out.rules) === JSON.stringify(rules)};
    }""")
    ok = (not result["out"].get("error") and result["out"].get("rules") is not None
          and result["matches"])
    return report(
        "5: export -> import round-trips", ok,
        f"error={result['out'].get('error')} matches={result['matches']}")


def reset_case(page, cx, cy) -> bool:
    """6: 'Reset to netviz defaults' resets the display and KEEPS the rules.

    The control moved out of the rules panel and into the menu, and its
    meaning changed with it: it used to delete the stored patch outright,
    which took the operator's custom-arc list with it. It now carries `arcs.custom`
    across and drops everything else, so the wall's appearance goes back to
    stock while a list somebody typed survives.

    Both halves are asserted, because either alone is passed by a bug: a
    reset that keeps everything would keep the rules too, and a reset that
    keeps nothing would still put the layer back. So this dirties a
    non-rule setting first (`layers.stars: false`), then checks it is back
    to true afterwards while the test rule is still there -- and that the
    stored patch now holds `arcs.custom` and nothing else.
    """
    # Close the panel: the menu is what carries the control now, and an open
    # panel would swallow the right-click that opens it.
    page.evaluate("() => { const p = document.querySelector('.custom-arc-panel'); if (p) p.remove(); }")
    page.evaluate("() => window.__netviz.settings.apply({'layers.stars': false})")
    page.wait_for_timeout(200)
    before = page.evaluate("""() => ({
      stored: window.localStorage.getItem('netviz.settings.v1'),
      stars: window.__netviz.cfgRead ? null : undefined,
    })""")
    dispatch_contextmenu(page, cx, cy)
    page.wait_for_timeout(200)
    row_present = page.evaluate(
        """() => !!document.querySelector('.menu [data-id="reset"]')""")
    if not row_present:
        return report("6: reset keeps the rules and resets the rest", False,
                      "no 'Reset to netviz defaults' row in the menu")
    # The menu row only ASKS now. Clicking it must not reset anything on its
    # own -- that is the whole point of the dialog, and a click that reloaded
    # here would be the accidental-click bug it exists to prevent. Asserted
    # before the dialog is answered: the storage is still there and the page
    # has not navigated.
    page.evaluate("""() => document.querySelector('.menu [data-id="reset"]')
                       .dispatchEvent(new MouseEvent('click', {bubbles: true}))""")
    page.wait_for_timeout(400)
    asked = page.evaluate("""() => {
      const el = document.querySelector('.confirm');
      if (!el) return {present: false};
      const r = el.getBoundingClientRect();
      const text = el.textContent || '';
      return {
        present: true, inDocument: document.contains(el), w: r.width, h: r.height,
        hasYes: !!el.querySelector('.confirm-yes'),
        hasNo: !!el.querySelector('.confirm-no'),
        saysWill: text.includes('WILL'), saysWont: text.includes('NOT'),
        namesTheLayer: text.toLowerCase().includes('stars'),
        promisesRules: text.toLowerCase().includes('custom arc'),
        stillStored: window.localStorage.getItem('netviz.settings.v1') !== null,
      };
    }""")
    dialog_ok = (asked.get("present") and asked.get("inDocument")
                 and asked.get("w", 0) > 0 and asked.get("hasYes") and asked.get("hasNo")
                 and asked.get("saysWill") and asked.get("saysWont")
                 and asked.get("namesTheLayer") and asked.get("promisesRules")
                 and asked.get("stillStored"))
    if not dialog_ok:
        return report("6: reset keeps the rules and resets the rest", False,
                      f"the confirm dialog did not gate the reset: {asked}")
    # Cancel first, and prove it really is a no-op, before answering yes. A
    # dialog whose No still resets is worse than no dialog at all.
    page.evaluate("() => document.querySelector('.confirm-no').click()")
    page.wait_for_timeout(300)
    after_cancel = page.evaluate("""() => ({
      gone: !document.querySelector('.confirm'),
      stillStored: window.localStorage.getItem('netviz.settings.v1') !== null,
    })""")
    if not (after_cancel["gone"] and after_cancel["stillStored"]):
        return report("6: reset keeps the rules and resets the rest", False,
                      f"cancel did not leave everything alone: {after_cancel}")
    dispatch_contextmenu(page, cx, cy)
    page.wait_for_timeout(200)
    page.evaluate("""() => document.querySelector('.menu [data-id="reset"]')
                       .dispatchEvent(new MouseEvent('click', {bubbles: true}))""")
    page.wait_for_timeout(400)
    with page.expect_navigation(wait_until="load", timeout=20_000):
        page.evaluate("() => document.querySelector('.confirm-yes').click()")
    page.wait_for_function("window.__netvizReady === true", timeout=20_000)
    page.wait_for_timeout(1000)
    result = page.evaluate("""async () => {
      const m = await import('./js/config.js');
      const raw = window.localStorage.getItem('netviz.settings.v1');
      const stored = raw ? JSON.parse(raw) : null;
      const rules = m.CONFIG.arcs.custom || [];
      return {
        storedKeys: stored ? Object.keys(stored) : [],
        keptOurRule: rules.some((r) => r.match === '203.0.113.0/24'),
        starsBack: m.cfg('layers.stars', true) === true,
        rules,
      };
    }""")
    ok = (result["keptOurRule"] and result["starsBack"]
          and result["storedKeys"] == ["arcs.custom"])
    return report(
        "6: reset keeps the rules and resets the rest", ok,
        f"kept our rule: {result['keptOurRule']}, layers.stars back to default: "
        f"{result['starsBack']}, stored keys now {result['storedKeys']} "
        f"(want ['arcs.custom']), before={before['stored'] is not None}")


def rail_lists_rule_case(page, cx, cy) -> bool:
    """7: the rail lists the rule.

    Applies `rail.enabled` and a `rail.maxRules` of 2, installs three rules,
    waits for real traffic to land on them, and asserts the rail shows
    exactly two real rows plus a `+1 more` overflow line -- proving the
    rank-by-last-hour path, not just that three rules produce three DOM rows.

    THE RULES PARTITION THE ADDRESS SPACE, THEY DO NOT NAME COUNTRIES, and
    that is what makes this case runnable at all against the deployment the
    release gate points it at. It matched DE/GB/JP from the synthetic feed's
    `AMBIENT_COUNTRIES` until 2026-08-14, where every country is equally
    likely and all three rules fire within seconds. A live feed is not
    uniform: 30s of the real one carried US 547, DE 160, CZ 26, SE 22, ZA 14,
    RU 4 and **no GB or JP at all**, so the second visible row sat at
    `0.0/min` until the 45s cap and the case failed on a rail that was
    working perfectly. It is the same trap as pointing `verify_walk` at the
    live wall -- see the note in `tools/verify_release.sh`.

    Three CIDRs that between them cover every IPv4 address cannot depend on
    who the router is talking to. `128.0.0.0/1` goes LAST because position is
    precedence and it contains the `192.168/16` home end of every event --
    first in the list it would claim the lot and starve the other two."""
    page.evaluate("""() => window.__netviz.settings.apply({
      'rail.enabled': true, 'rail.maxRules': 2,
      'arcs.custom': [
        {match: '0.0.0.0/2', color: '#ff0000', name: 'r-low', enabled: true},
        {match: '64.0.0.0/2', color: '#00ff00', name: 'r-mid', enabled: true},
        {match: '128.0.0.0/1', color: '#0000ff', name: 'r-high', enabled: true},
      ],
    })""")

    # HOW MANY RULE ROWS ARE VISIBLE IS NOT A CONSTANT, and asserting one was
    # the second way this case failed on a rail that was working. `fitRuleCap`
    # drops rows to whatever the rail has room for, and the room depends on the
    # panels ABOVE it -- GEO BLOCKS 24H grows a row per blocked country as the
    # day goes on. Measured hours apart on the same build: that panel went 223px
    # -> 389px, free space 315px -> 102px, and the fit legitimately went from
    # two rule rows to one. So the assertion is the CONTRACT, not a count: the
    # rendered panel agrees with what `fitRuleCap` decides on the rail's own
    # live measurements, the overflow line names exactly the remainder, and
    # every visible row carries traffic.
    def snapshot():
        return page.evaluate("""async () => {
          const secs = [...document.querySelectorAll('.rail-panel')];
          const sec = secs.find((s) => {
            const h = s.querySelector('.rail-panel-title');
            return h && h.firstChild && h.firstChild.textContent.trim() === 'CUSTOM ARCS';
          });
          if (!sec) return {found: false};
          // `:not(.legend)`. Since 0.6.1 this panel opens with the two
          // built-in arc classes as a key -- they are not rules, they never
          // carry a rate, and the rule fitter excludes them from its own row
          // set for the same reason (see rail.js measure()). Counting them
          // here would mean asserting a rule count two too high and waiting
          // for a rate on a row that will never have one.
          const rows = [...sec.querySelectorAll('.rail-row:not(.legend)')].map((r) => ({
            label: r.querySelector('.rail-label').textContent,
            value: r.querySelector('.rail-value').textContent,
            muted: r.classList.contains('muted'),
          }));
          const legendRows = sec.querySelectorAll('.rail-row.legend').length;
          // The same numbers rail.js's own measure() reads, handed to the same
          // pure function it hands them to. Imported from the served page, so a
          // change to the arithmetic moves the expectation with it.
          const { fitRuleCap, ruleBoxMetrics, railContentHeight } =
            await import('/js/rail.js');
          const root = document.getElementById('rail');
          const box = root.querySelector('.rail-panel-rules');
          const st = getComputedStyle(root);
          const rowRects = [...box.querySelectorAll('.rail-row:not(.legend)')]
            .map((r) => r.getBoundingClientRect().height);
          const boxH = box.getBoundingClientRect().height;
          const content = railContentHeight({
            childHeights: [...root.children].map((e) => e.getBoundingClientRect().height),
            gap: parseFloat(st.rowGap),
            padding: parseFloat(st.paddingTop) + parseFloat(st.paddingBottom),
          });
          const total = 3;
          const expected = fitRuleCap({
            available: root.clientHeight, other: content - boxH,
            ...ruleBoxMetrics(boxH, rowRects), total, maxRules: 2,
          });
          return {found: true, rows, expected, total, legendRows,
                  free: Math.round(root.clientHeight - content),
                  overflows: root.scrollHeight > root.clientHeight};
        }""")

    # A row count alone is true from the very first redraw, before any traffic
    # at all -- rulePanel lists every enabled rule regardless of hits, just
    # ranked by an hour that starts at zero. That would pass even if the
    # counting pipeline were totally broken, so what is waited for is every
    # VISIBLE row showing a non-zero rate, which only matched traffic produces.
    def nonzero_rate(row):
        return row["value"] != "0.0/min"

    def settled(snap):
        rows = snap.get("rows", [])
        shown = snap.get("expected", 0)
        return (snap.get("found") and shown and len(rows) == shown + 1
                and all(nonzero_rate(r) for r in rows[:shown]))

    t0 = time.time()
    snap = snapshot()
    while time.time() - t0 < RULE_TRAFFIC_CAP_SECONDS and not settled(snap):
        time.sleep(1.0)
        snap = snapshot()

    rows = snap.get("rows", [])
    shown = snap.get("expected", 0)
    overflow = rows[-1] if rows else None
    ok = (settled(snap)
          # The key is there and is exactly the two built-in classes.
          and snap.get("legendRows") == 2
          and all(not r["muted"] for r in rows[:shown])
          and overflow is not None and overflow["muted"]
          and overflow["label"] == f"+{snap['total'] - shown} more"
          # The fit's whole purpose: whatever it decided, the rail fits on screen.
          and not snap.get("overflows"))
    ok2 = report(
        "7: the rail lists the rule", ok,
        f"waited {time.time() - t0:.1f}s, fitted {shown} of {snap.get('total')} "
        f"with {snap.get('free')}px free, {snap.get('legendRows')} legend rows, "
        f"overflowing={snap.get('overflows')}, "
        f"rows={rows}")
    # restore, for hygiene against anything run afterward in the same page
    page.evaluate("() => window.__netviz.settings.apply({'rail.enabled': false})")
    return ok2


def keyboard_typing_case(page, cx, cy) -> bool:
    """8: the panel's text fields can be typed into with a keyboard.

    Regression test for `input.js`'s global keydown handler eating
    keystrokes meant for the panel: before it checked `ev.target`, '-'
    zoomed the camera out (untyping an address range like
    '203.0.113.10-203.0.113.40'), 'f' toggled fullscreen (untyping a name
    like 'firewall'), and 's' opened the on-screen menu OVER the open
    panel (untyping a lowercase country code).

    Uses `page.keyboard.type()` -- real keydown/keyup events dispatched at
    the OS/browser level, not a synthetic `input` event constructed in JS
    -- because the bug is specifically that `window`'s keydown listener
    intercepts the keystroke before the input box's own value ever
    changes; a fabricated `Event('input')` would never exercise that path
    at all and would pass whether or not the fix was in place."""
    if not page.evaluate("() => !!document.querySelector('.custom-arc-panel')"):
        open_menu_and_click(page, "rules", cx, cy)
        page.wait_for_timeout(300)
    page.evaluate("() => { const m = document.querySelector('.menu'); if (m) m.remove(); }")

    add_btn = page.query_selector(".custom-arc-add")
    if not add_btn:
        return report("8: the panel's text fields can be typed into", False,
                       "no .custom-arc-add -- is the panel open?")
    add_btn.click()
    page.wait_for_timeout(100)
    rows = page.query_selector_all(".custom-arc-row")
    if not rows:
        return report("8: the panel's text fields can be typed into", False,
                       "add did not append a row")
    row = rows[-1]
    match = row.query_selector(".custom-arc-match")
    name = row.query_selector(".custom-arc-name")

    match_text = "203.0.113.10-203.0.113.40"
    name_text = "firewalls"   # carries both 'f' (fullscreen) and 's' (menu)

    match.click()
    page.keyboard.type(match_text, delay=15)
    name.click()
    page.keyboard.type(name_text, delay=15)

    result = page.evaluate("""({matchSel, nameSel}) => {
      const rows = document.querySelectorAll('.custom-arc-row');
      const row = rows[rows.length - 1];
      return {
        matchValue: row.querySelector('.custom-arc-match').value,
        nameValue: row.querySelector('.custom-arc-name').value,
        menuOpen: !!document.querySelector('.menu'),
      };
    }""", {"matchSel": ".custom-arc-match", "nameSel": ".custom-arc-name"})

    ok = (result["matchValue"] == match_text and result["nameValue"] == name_text
          and not result["menuOpen"])
    # Clean up the scratch row so later cases (which assume a known panel
    # state) are not confused by it.
    row2 = page.query_selector_all(".custom-arc-row")[-1]
    del_btn = row2.query_selector(".custom-arc-delete")
    if del_btn:
        del_btn.click()
        page.wait_for_timeout(100)
    return report(
        "8: the panel's text fields can be typed into", ok,
        f"match field: {result['matchValue']!r} (wanted {match_text!r}), "
        f"name field: {result['nameValue']!r} (wanted {name_text!r}), "
        f"menu opened: {result['menuOpen']}")


def rule_deletion_reclass_case(page) -> bool:
    """9: deleting a rule reclassifies arcs already in the air by their OWN
    match, not by the class index they happened to occupy.

    `setRules` used to walk only slots whose `cls` started with 'rule' and
    re-look-up `CLASS[slot.cls]` by NAME -- a position, not an identity.
    Installs two rules (A, B), spawns one live arc matching each, then
    deletes A. The bug: the arc that matched A (was `rule1`) inherited
    whatever now sits at index 1 -- i.e. B's color, a match it never had
    -- while the arc that matched B (was `rule2`) found no `CLASS.rule2`
    at all and fell back to flow violet even though B still claims it.
    Both are wrong; the fix re-matches each slot's stored spawning event
    against the freshly compiled list."""
    result = page.evaluate("""async () => {
      const {arcs, settings} = window.__netviz;
      const evA = {k: 'flow', s: '198.51.100.11', d: '198.51.100.12',
                   sll: [10, 10], dll: [12, 12], b: 500};
      const evB = {k: 'flow', s: '198.51.100.21', d: '198.51.100.22',
                   sll: [20, 20], dll: [22, 22], b: 500};
      settings.apply({'arcs.custom': [
        {match: '198.51.100.11/32', color: '#ff0000', name: 'ruleA', enabled: true},
        {match: '198.51.100.21/32', color: '#00ff00', name: 'ruleB', enabled: true},
      ]});
      await new Promise((r) => setTimeout(r, 50));

      function spawnAndTrack(ev) {
        const before = arcs.group.children.map((m) => m.geometry.uuid);
        arcs.spawn(ev);
        return arcs.group.children.filter((m, i) => m.geometry.uuid !== before[i]);
      }
      let liveA = [];
      let liveB = [];
      const deadline = performance.now() + 2000;
      while ((!liveA.length || !liveB.length) && performance.now() < deadline) {
        if (!liveA.length) liveA = spawnAndTrack(evA);
        if (!liveB.length) liveB = spawnAndTrack(evB);
        if (!liveA.length || !liveB.length) await new Promise((r) => setTimeout(r, 60));
      }
      if (!liveA.length || !liveB.length) {
        return {error: 'could not spawn tracked arcs for both rules'};
      }

      const flowHex = arcs.classColor('flow').getHex();

      // Delete rule A -- only B remains, now at index 0 (class 'rule1').
      settings.apply({'arcs.custom': [
        {match: '198.51.100.21/32', color: '#00ff00', name: 'ruleB', enabled: true},
      ]});
      await new Promise((r) => setTimeout(r, 50));

      // B's expected color is read from the LIVE class table, not a raw
      // literal: gain (arcs.highlight, default 0.70) scales every rule
      // color down, so comparing against '#00ff00' directly would fail
      // for a reason that has nothing to do with which rule an arc is
      // attached to.
      const bWantHex = arcs.classColor('rule1').getHex();

      return {
        aHex: liveA[0].material.uniforms.color.value.getHex(),
        bHex: liveB[0].material.uniforms.color.value.getHex(),
        flowHex, bWantHex,
      };
    }""")
    if result.get("error"):
        return report("9: deleting a rule reclassifies by match, not index", False,
                       result["error"])
    a_ok = result["aHex"] == result["flowHex"]
    b_ok = result["bHex"] == result["bWantHex"]
    ok = a_ok and b_ok
    return report(
        "9: deleting a rule reclassifies by match, not index", ok,
        f"deleted rule's arc -> flow (#{result['flowHex']:06x}): "
        f"{a_ok} (got #{result['aHex']:06x}); "
        f"surviving rule's arc keeps its own color (#{result['bWantHex']:06x}): "
        f"{b_ok} (got #{result['bHex']:06x})")


def builtin_colors_case(page, cx, cy) -> bool:
    """10: the two built-in arc classes are colored from THIS panel.

    They were two ramp-position sliders on the tuning panel until 0.6.1 --
    one panel for "what color is a block", another for "what color is this
    rule", and the rail's legend a third place claiming both were amber.
    They now sit IN the custom-arc list rather than in a section above it, first
    and last, which is the engine's real precedence: a block is never
    recolored by a rule, and a flow no rule claims falls through to the last
    row. The panel's hint says the list is checked top to bottom, and that
    was only true of the middle of it while the defaults sat outside.
    What is checked here is that the swatch writes the real setting, that it
    reaches the arcs already in the air (a color that only applied to the
    next spawn reads as a dead control on a wall where a block lives 18s),
    and that the undo returns the class to the theme rather than to a
    remembered hex."""
    page.evaluate("() => { const p = document.querySelector('.custom-arc-panel'); if (p) p.remove(); }")
    open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)

    state = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const rows = [...document.querySelectorAll('.custom-arc-fixed')];
      const before = { block: c.cfg('arcs.block.color', null), flow: c.cfg('arcs.flow.color', null) };
      const swatches = rows.map((r) => r.querySelector('input[type=color]').value);
      // The two fixed rows are IN the list, first and last, with the
      // editable rules between them -- one list in the engine's own
      // precedence order. Asserted here so a future edit cannot quietly pull
      // them back out into a section of their own.
      const list = [...document.querySelector('.custom-arc-list').children];
      return { count: rows.length, before, swatches,
               firstIsFixed: list[0].className === 'custom-arc-fixed',
               lastIsFixed: list[list.length - 1].className === 'custom-arc-fixed',
               inList: rows.every((r) => r.parentElement.className === 'custom-arc-list'),
               autoDisabled: rows.map((r) => r.querySelector('button').disabled) };
    }""")

    # Set the block class green through the swatch, the way a person would.
    page.eval_on_selector(
        ".custom-arc-fixed input[type=color]",
        """(el) => { el.value = '#00ff88';
                     el.dispatchEvent(new Event('input', { bubbles: true })); }""")
    page.wait_for_timeout(400)
    after = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const live = window.__netviz.arcs.classColor('block');
      const row = document.querySelector('.custom-arc-fixed');
      return { stored: c.cfg('arcs.block.color', null),
               live: { r: live.r, g: live.g, b: live.b },
               undoEnabled: !row.querySelector('button').disabled };
    }""")

    page.eval_on_selector(".custom-arc-fixed button", "(el) => el.click()")
    page.wait_for_timeout(400)
    back = page.evaluate("""async () => {
      const c = await import('./js/config.js');
      const row = document.querySelector('.custom-arc-fixed');
      const live = window.__netviz.arcs.classColor('block');
      return { stored: c.cfg('arcs.block.color', null),
               swatch: row.querySelector('input[type=color]').value,
               live: { r: live.r, g: live.g, b: live.b },
               undoDisabled: row.querySelector('button').disabled };
    }""")

    # The LIVE class color, not just the stored setting. This is the half
    # that caught the real bug: `setSpec(cls, 'color', hex)` wrote the value
    # and then recomputed the resolved color from the class's original hex,
    # so the setting stored, persisted, read back correctly and changed
    # nothing on the wall. Green must dominate red after the write, and the
    # class must be back to its amber-ish theme color after the undo.
    live_after = after.get("live") or {}
    live_back = back.get("live") or {}
    greened = live_after.get("g", 0) > live_after.get("r", 1) * 5
    restored = live_back.get("r", 0) > live_back.get("g", 1)

    ok = (state.get("count") == 2
          and state.get("inList") and state.get("firstIsFixed")
          and state.get("lastIsFixed")
          and after.get("stored") == "#00ff88"
          and greened and restored
          and after.get("undoEnabled") is True
          and back.get("stored") == "auto"
          # Back on auto the swatch shows the THEME's color for the class,
          # not the hex just discarded -- the panel resolves through the ramp
          # rather than remembering.
          and back.get("swatch") != "#00ff88"
          and back.get("undoDisabled") is True)
    return report("10: the built-in arc colors are set from the rules panel", ok,
                  f"rows={state.get('count')} in one list="
                  f"{state.get('inList')} first/last={state.get('firstIsFixed')}"
                  f"/{state.get('lastIsFixed')} before={state.get('before')} "
                  f"live went green={greened} and back={restored}; "
                  f"after={after} back={back}")


def run(page, cx, cy) -> bool:
    ok = True
    ok &= panel_open_case(page, cx, cy)
    ok &= live_recolor_case(page)
    ok &= bad_row_case(page)
    ok &= keyboard_typing_case(page, cx, cy)
    ok &= reload_survives_case(page)
    # The reload above dropped the panel; reopen it for the cases that need it.
    open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    ok &= export_import_roundtrip_case(page)
    ok &= reset_case(page, cx, cy)
    # reset_case's reload dropped the panel too, and cleared the rule --
    # case 7 installs its own rules independently, so it does not need it open.
    ok &= rail_lists_rule_case(page, cx, cy)
    ok &= rule_deletion_reclass_case(page)
    ok &= builtin_colors_case(page, cx, cy)
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
            ok = run(page, rect["cx"], rect["cy"])
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
