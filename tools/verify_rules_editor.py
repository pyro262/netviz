#!/usr/bin/env python3
"""Prove the colour-rules EDITOR against a real page.

`rules.js`'s arithmetic and `rulestore.js`'s pure half are proved under
`node --test`. What that cannot prove is the same gap `verify_rules.py`
exists for one layer down: that the PANEL a person actually clicks writes
through to arcs already on screen, survives a reload, and that the menu
opener really produces a document-attached element -- not just an object
that claims `isOpen()`. That split (an API's own claim vs. the element
actually being in the DOM with a non-zero rect) is exactly the bug that got
through a unit suite and a code review the same week for the menu itself;
this script holds the panel to the same standard.

`rules_panel.js` imports nothing from three, but it is driven entirely
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
    page.evaluate("() => { const p = document.querySelector('.rules-panel'); if (p) p.remove(); }")
    clicked = open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    state = page.evaluate("""() => {
      const el = document.querySelector('.rules-panel');
      if (!el) return {present: false};
      const r = el.getBoundingClientRect();
      return {present: true, inDocument: document.contains(el), w: r.width, h: r.height};
    }""")
    ok = (clicked and state.get("present") and state.get("inDocument")
          and state.get("w", 0) > 0 and state.get("h", 0) > 0)
    return report("1: the panel really opens", ok, f"clicked={clicked} state={state}")


def live_recolour_case(page) -> bool:
    """2: typing recolours live arcs.

    The arc is spawned BEFORE the rule is typed, on purpose -- a rule that
    only reached arcs spawned later would still read as a dead control on
    the wall, the same reasoning verify_rules.py's case 1 documents. This
    also types more than one character with real `input` events and checks
    focus never leaves the field, the regression test for Task 3's
    patch-in-place fix: rebuilding every row on each keystroke would steal
    focus from under the person typing.

    Two things this repo's own state made non-obvious, both handled below:
    the synthetic collector migrates three NETVIZ_HIGHLIGHT* demo rules into
    `arcs.rules` before this panel ever opens (`rulesFromNetworks` in
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
      // background, so filtering group.children by "shares flow's colour"
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

      const addBtn = document.querySelector('.rules-add');
      if (!addBtn) return {error: 'no add-rule button -- is the panel open?'};
      const before = document.querySelectorAll('.rules-row').length;
      addBtn.click();
      const rows = document.querySelectorAll('.rules-row');
      if (rows.length !== before + 1) {
        return {error: `add did not append exactly one row (${before} -> ${rows.length})`};
      }
      const row = rows[rows.length - 1];           // the one just added, whatever its index
      const match = row.querySelector('.rules-match');
      const colour = row.querySelector('.rules-colour');
      match.focus();
      let acc = '';
      for (const ch of '203.0.113.0/24') {
        acc += ch;
        match.value = acc;
        match.dispatchEvent(new Event('input', {bubbles: true}));
      }
      const stillFocused = document.activeElement === match;
      colour.value = '#ff00ff';
      colour.dispatchEvent(new Event('input', {bubbles: true}));

      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 100));
      const cls = cl.classNameFor(ev);              // whichever rule slot this became
      const beforeHex = arcs.classColour('flow').getHex();
      const afterHex = arcs.classColour(cls) ? arcs.classColour(cls).getHex() : null;
      const moved = live.filter(
        (mesh) => mesh.material.uniforms.color.value.getHex() === afterHex).length;
      // Handed to case 3: which rule slot our rule became, and the address
      // that reaches it -- case 3 checks THIS rule survives an unrelated bad
      // row, not literally CONFIG.arcs.rules[0], because the synthetic
      // collector's own NETVIZ_HIGHLIGHT* migration already occupies index 0.
      if (cls !== 'flow' && afterHex !== null) window.__vreRule = {cls, ev};
      return {beforeHex, afterHex, moved, live: live.length, stillFocused, cls,
              ms: performance.now() - t0};
    }""")
    if result.get("error"):
        return report("2: typing recolours live arcs", False, result["error"])
    ok = (result["cls"] != "flow" and result["afterHex"] is not None
          and result["afterHex"] != result["beforeHex"]
          and result["moved"] == result["live"] and result["stillFocused"])
    return report(
        "2: typing recolours live arcs", ok,
        f"class {result['cls']}, {result['moved']}/{result['live']} live arcs moved "
        f"#{result['beforeHex']:06x} -> #{result['afterHex']:06x}, "
        f"stillFocused={result['stillFocused']}, {result['ms']:.0f}ms")


def bad_row_case(page) -> bool:
    """3: a bad row costs nothing.

    Adds another row with an unparseable matcher and asserts `.rules-reason`
    shows on that row only, and that CASE 2'S RULE -- not literally
    `arcs.rules[0]`, which on this synthetic collector is already occupied by
    the NETVIZ_HIGHLIGHT* migration -- keeps colouring its arcs: an invalid
    row must not blank out a working one."""
    have_rule = page.evaluate("() => !!window.__vreRule")
    if not have_rule:
        return report("3: a bad row costs nothing", False,
                       "case 2 did not hand off a rule to check against")
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const cl = await import('./js/classify.js');
      const {cls, ev} = window.__vreRule;
      const goodRow = [...document.querySelectorAll('.rules-row')].find(
        (r) => r.querySelector('.rules-match').value === '203.0.113.0/24');

      const addBtn = document.querySelector('.rules-add');
      const before = document.querySelectorAll('.rules-row').length;
      addBtn.click();
      const rows = document.querySelectorAll('.rules-row');
      if (rows.length !== before + 1) {
        return {error: `add did not append exactly one row (${before} -> ${rows.length})`};
      }
      const badRow = rows[rows.length - 1];
      const match = badRow.querySelector('.rules-match');
      match.focus();
      match.value = 'nonsense';
      match.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 50));

      const badReason = badRow.querySelector('.rules-reason');
      const goodReason = goodRow ? goodRow.querySelector('.rules-reason') : null;

      const stillCls = cl.classNameFor(ev);
      const ruleHex = arcs.classColour(cls) ? arcs.classColour(cls).getHex() : null;
      // A FRESH arc, spawned after the bad row, must still take the rule's
      // colour -- proving the bad row did not knock the good one out of the
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
        f"still took its colour")


def reload_survives_case(page) -> bool:
    """4: it survives a reload.

    Reloads the real page and checks CONFIG.arcs.rules still carries the
    rule, and that a fresh arc from the same address takes it -- proving
    the persisted patch, not just the in-memory CONFIG, is what survived."""
    page.reload(wait_until="load")
    page.wait_for_function("window.__netvizReady === true", timeout=20_000)
    page.wait_for_timeout(1500)
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      const rules = m.CONFIG.arcs.rules || [];
      const has = rules.some((r) => r.match === '203.0.113.0/24');
      const cl = await import('./js/classify.js');
      const cls = cl.classNameFor({k: 'flow', s: '203.0.113.9', d: '198.51.100.7'});
      return {rules, has, cls};
    }""")
    ok = result["has"] and result["cls"].startswith("rule")
    return report(
        "4: it survives a reload", ok,
        f"CONFIG.arcs.rules has the rule: {result['has']}, "
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
        {match: '203.0.113.0/24', end: 'either', colour: '#ff00ff', name: 'doc-net', enabled: true},
        {match: 'DE', end: 'either', colour: '#22d3ee', name: '', enabled: false},
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


def reset_case(page) -> bool:
    """6: reset returns the collector's rules.

    Clicks 'Reset to collector', waits for the reload it triggers, and
    checks CONFIG.arcs.rules is back to whatever /config.json implies.

    NOT necessarily empty: the synthetic collector fills the three
    NETVIZ_HIGHLIGHT* slots with demo prefixes precisely so synthetic mode
    still exercises the migration (`netviz/synthetic.py`'s
    DEMO_HIGHLIGHT_PREFIXES), and `mergeServerConfig` migrates those into
    `arcs.rules` whenever CONFIG.arcs.rules is empty at load -- which it is,
    once the stored patch (holding our test rule) is gone. So this recomputes
    the expected list the same way the page just did, via the exported
    `rulesFromNetworks`, rather than assuming empty. What matters is that our
    custom rule is gone and the stored patch is cleared."""
    has_rows = page.evaluate("() => document.querySelectorAll('.rules-row').length > 0")
    if not has_rows:
        return report("6: reset returns the collector's rules", False,
                       "rules panel is not open with rows -- nothing to reset")
    with page.expect_navigation(wait_until="load", timeout=20_000):
        page.evaluate("() => document.querySelector('.rules-reset').click()")
    page.wait_for_function("window.__netvizReady === true", timeout=20_000)
    page.wait_for_timeout(1000)
    result = page.evaluate("""async () => {
      const m = await import('./js/config.js');
      const stored = window.localStorage.getItem('netviz.settings.v1');
      const r = await fetch('/config.json', {cache: 'no-store'});
      const served = r.ok ? await r.json() : null;
      const networks = served && served.highlight && served.highlight.networks;
      const expected = Array.isArray(networks) ? m.rulesFromNetworks(networks).rules : [];
      const rules = m.CONFIG.arcs.rules || [];
      return {
        rules, stored, expected,
        matchesExpected: JSON.stringify(rules) === JSON.stringify(expected),
        hasOurRule: rules.some((r2) => r2.match === '203.0.113.0/24'),
      };
    }""")
    ok = (result["matchesExpected"] and not result["hasOurRule"] and result["stored"] is None)
    return report(
        "6: reset returns the collector's rules", ok,
        f"matches /config.json's migrated rules: {result['matchesExpected']}, "
        f"our test rule gone: {not result['hasOurRule']}, storage={result['stored']}, "
        f"rules={result['rules']}")


def rail_lists_rule_case(page, cx, cy) -> bool:
    """7: the rail lists the rule.

    Applies `rail.enabled` and a `rail.maxRules` of 2, installs three rules
    matched against countries the synthetic feed actually emits
    (`AMBIENT_COUNTRIES` in `netviz/synthetic.py`), waits for real traffic
    to land on all three, and asserts the rail shows exactly two real rows
    plus a `+1 more` overflow line -- proving the rank-by-last-hour path,
    not just that three rules produce three DOM rows."""
    page.evaluate("""() => window.__netviz.settings.apply({
      'rail.enabled': true, 'rail.maxRules': 2,
      'arcs.rules': [
        {match: 'DE', colour: '#ff0000', name: 'r-de', enabled: true},
        {match: 'GB', colour: '#00ff00', name: 'r-gb', enabled: true},
        {match: 'JP', colour: '#0000ff', name: 'r-jp', enabled: true},
      ],
    })""")

    def snapshot():
        return page.evaluate("""() => {
          const secs = [...document.querySelectorAll('.rail-panel')];
          const sec = secs.find((s) => {
            const h = s.querySelector('.rail-panel-title');
            return h && h.firstChild && h.firstChild.textContent.trim() === 'COLOR RULES';
          });
          if (!sec) return {found: false};
          const rows = [...sec.querySelectorAll('.rail-row')].map((r) => ({
            label: r.querySelector('.rail-label').textContent,
            value: r.querySelector('.rail-value').textContent,
            muted: r.classList.contains('muted'),
          }));
          return {found: true, rows};
        }""")

    # The row count alone (3 = 2 real + overflow) is true from the very first
    # redraw, before any traffic at all -- rulePanel lists every enabled rule
    # regardless of hits, just ranked by an hour that starts at zero. That
    # would make this case pass even if the counting pipeline were totally
    # broken, so the real condition waited for is BOTH visible rows showing
    # a non-zero rate, which only real matched traffic can produce.
    def nonzero_rate(row):
        return row["value"] != "0.0/min"

    t0 = time.time()
    snap = snapshot()
    while time.time() - t0 < RULE_TRAFFIC_CAP_SECONDS:
        rows = snap.get("rows", [])
        if (snap.get("found") and len(rows) == 3
                and all(nonzero_rate(r) for r in rows[:2])):
            break
        time.sleep(1.0)
        snap = snapshot()

    rows = snap.get("rows", [])
    overflow = rows[-1] if rows else None
    ok = (snap.get("found") and len(rows) == 3
          and all(not r["muted"] and nonzero_rate(r) for r in rows[:2])
          and overflow is not None and overflow["muted"] and overflow["label"] == "+1 more")
    ok2 = report(
        "7: the rail lists the rule", ok,
        f"waited {time.time() - t0:.1f}s, rows={rows}")
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
    if not page.evaluate("() => !!document.querySelector('.rules-panel')"):
        open_menu_and_click(page, "rules", cx, cy)
        page.wait_for_timeout(300)
    page.evaluate("() => { const m = document.querySelector('.menu'); if (m) m.remove(); }")

    add_btn = page.query_selector(".rules-add")
    if not add_btn:
        return report("8: the panel's text fields can be typed into", False,
                       "no .rules-add -- is the panel open?")
    add_btn.click()
    page.wait_for_timeout(100)
    rows = page.query_selector_all(".rules-row")
    if not rows:
        return report("8: the panel's text fields can be typed into", False,
                       "add did not append a row")
    row = rows[-1]
    match = row.query_selector(".rules-match")
    name = row.query_selector(".rules-name")

    match_text = "203.0.113.10-203.0.113.40"
    name_text = "firewalls"   # carries both 'f' (fullscreen) and 's' (menu)

    match.click()
    page.keyboard.type(match_text, delay=15)
    name.click()
    page.keyboard.type(name_text, delay=15)

    result = page.evaluate("""({matchSel, nameSel}) => {
      const rows = document.querySelectorAll('.rules-row');
      const row = rows[rows.length - 1];
      return {
        matchValue: row.querySelector('.rules-match').value,
        nameValue: row.querySelector('.rules-name').value,
        menuOpen: !!document.querySelector('.menu'),
      };
    }""", {"matchSel": ".rules-match", "nameSel": ".rules-name"})

    ok = (result["matchValue"] == match_text and result["nameValue"] == name_text
          and not result["menuOpen"])
    # Clean up the scratch row so later cases (which assume a known panel
    # state) are not confused by it.
    row2 = page.query_selector_all(".rules-row")[-1]
    del_btn = row2.query_selector(".rules-delete")
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
    whatever now sits at index 1 -- i.e. B's colour, a match it never had
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
      settings.apply({'arcs.rules': [
        {match: '198.51.100.11/32', colour: '#ff0000', name: 'ruleA', enabled: true},
        {match: '198.51.100.21/32', colour: '#00ff00', name: 'ruleB', enabled: true},
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

      const flowHex = arcs.classColour('flow').getHex();

      // Delete rule A -- only B remains, now at index 0 (class 'rule1').
      settings.apply({'arcs.rules': [
        {match: '198.51.100.21/32', colour: '#00ff00', name: 'ruleB', enabled: true},
      ]});
      await new Promise((r) => setTimeout(r, 50));

      // B's expected colour is read from the LIVE class table, not a raw
      // literal: gain (arcs.highlight, default 0.70) scales every rule
      // colour down, so comparing against '#00ff00' directly would fail
      // for a reason that has nothing to do with which rule an arc is
      // attached to.
      const bWantHex = arcs.classColour('rule1').getHex();

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
        f"surviving rule's arc keeps its own colour (#{result['bWantHex']:06x}): "
        f"{b_ok} (got #{result['bHex']:06x})")


def run(page, cx, cy) -> bool:
    ok = True
    ok &= panel_open_case(page, cx, cy)
    ok &= live_recolour_case(page)
    ok &= bad_row_case(page)
    ok &= keyboard_typing_case(page, cx, cy)
    ok &= reload_survives_case(page)
    # The reload above dropped the panel; reopen it for the cases that need it.
    open_menu_and_click(page, "rules", cx, cy)
    page.wait_for_timeout(300)
    ok &= export_import_roundtrip_case(page)
    ok &= reset_case(page)
    # reset_case's reload dropped the panel too, and cleared the rule --
    # case 7 installs its own rules independently, so it does not need it open.
    ok &= rail_lists_rule_case(page, cx, cy)
    ok &= rule_deletion_reclass_case(page)
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
