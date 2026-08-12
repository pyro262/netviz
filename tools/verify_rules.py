#!/usr/bin/env python3
"""Prove the colour rules against a real page.

`rules.js` is three-free and its arithmetic is proved under `node --test`.
What that cannot prove is the half that decides whether a control is real:
that installing a rule recolours the arcs ALREADY IN THE AIR rather than
only the ones spawned afterwards. Six settings controls shipped dead for
exactly that reason -- the value was written to a spec every live arc had
already copied out of. So this drives the page.

`arcs.js` imports three and there is no node_modules here, so none of it
can be reached under `node --test` at all; a real browser is the only
instrument.

    python3 tools/verify_rules.py
    python3 tools/verify_rules.py --url http://HOST:8099/
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8499"))

# A cap, not a duration: case 4 stops as soon as the live feed has produced
# an arc on the country rule. Simulated time runs behind wall clock under
# headless swiftshader, so nothing here is sized off the event rate.
COUNTRY_CAP_SECONDS = 60

RESULTS: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    RESULTS.append((name, ok, detail))
    return ok


def live_recolour_case(page) -> bool:
    """A rule installed while an arc is on screen recolours THAT arc.

    The arc is spawned first and the rule changed second, on purpose: a
    rule change that only reached arcs spawned later would pass a naive
    "the class colour moved" check and still read as a dead control on the
    wall, because a rule1 arc lives 4s and the next one may be seconds
    away.
    """
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      // Documentation space, so nothing the synthetic feed emits collides
      // with it and the arc being measured is the one spawned here.
      m.CONFIG.arcs.rules = [{match: '203.0.113.0/24', colour: '#22d3ee'}];
      arcs.setRules(m.CONFIG.arcs.rules);
      const before = arcs.classColour('rule1').getHex();
      const ev = {k: 'flow', s: '203.0.113.9', d: '198.51.100.7',
                  sll: [-40, 150], dll: [-45, 160], b: 1000};
      arcs.spawn(ev);
      const live = arcs.group.children.filter(
        (mesh) => mesh.visible && mesh.material.uniforms.color.value.getHex() === before);
      if (!live.length) return {error: 'no arc took the rule colour on spawn'};

      const t0 = performance.now();
      m.CONFIG.arcs.rules = [{match: '203.0.113.0/24', colour: '#ff00ff'}];
      const out = arcs.setRules(m.CONFIG.arcs.rules);
      const after = arcs.classColour('rule1').getHex();
      // 100ms is the same bound the settings catalogue was verified against.
      await new Promise((r) => setTimeout(r, 100));
      const moved = live.filter(
        (mesh) => mesh.material.uniforms.color.value.getHex() === after).length;
      return {before, after, moved, live: live.length,
              applied: out.applied, ms: performance.now() - t0};
    }""")
    if result.get("error"):
        return report("1: a rule recolours arcs already on screen", False, result["error"])
    ok = (result["moved"] == result["live"] and result["before"] != result["after"])
    return report(
        "1: a rule recolours arcs already on screen", ok,
        f"{result['moved']}/{result['live']} live arcs moved "
        f"#{result['before']:06x} -> #{result['after']:06x} in {result['ms']:.0f}ms")


def block_immunity_case(page) -> bool:
    """A block is never coloured by a rule, whatever it matched.

    The rule matches the block's own address deliberately: the wall exists
    to show blocks, and the alarm layer is one visual language -- outline,
    arc, ripple and flash share the hue.
    """
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      m.CONFIG.arcs.rules = [{match: '198.51.100.0/24', colour: '#00ff00'}];
      arcs.setRules(m.CONFIG.arcs.rules);
      const ruleHex = arcs.classColour('rule1').getHex();
      const blockHex = arcs.classColour('block').getHex();
      const cl = await import('./js/classify.js');
      const ev = {k: 'block', s: '198.51.100.7', d: '192.168.0.1', sc: 'CN', dc: '--',
                  sll: [39.9, 116.4], dll: [29.8, -95.4], b: 900};
      const cls = cl.classNameFor(ev);
      arcs.spawn(ev);
      const wrong = arcs.group.children.filter(
        (mesh) => mesh.visible
               && mesh.material.uniforms.color.value.getHex() === ruleHex
               && Math.abs(mesh.material.uniforms.head.value) < 0.02).length;
      return {cls, ruleHex, blockHex, wrong};
    }""")
    ok = result["cls"] == "block" and result["ruleHex"] != result["blockHex"]
    return report(
        "2: a block ignores every rule", ok,
        f"class {result['cls']}, block #{result['blockHex']:06x} "
        f"vs rule #{result['ruleHex']:06x}")


def refusal_case(page) -> bool:
    """A malformed rule does not cost the good ones.

    Half a wall applied beats a wall that dropped everything after the
    first bad entry -- the same call apply.js's executor makes. The refusal
    is reported by its index in the ORIGINAL list, so the message names the
    row somebody actually wrote.
    """
    result = page.evaluate("""async () => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      m.CONFIG.arcs.rules = [
        {match: '203.0.113.0/24', colour: '#22d3ee'},
        {match: 'nonsense', colour: '#ffffff'},
        {match: '198.51.100.0/24', colour: '#ff8800'},
      ];
      const out = arcs.setRules(m.CONFIG.arcs.rules);
      const cl = await import('./js/classify.js');
      // The third row is the SECOND surviving rule, so an event matching it
      // must draw in rule2's colour -- the refusal shifts the ones after it
      // and the classes must agree with the compiled list, not the raw one.
      const cls = cl.classNameFor({k: 'flow', s: '198.51.100.7', d: '192.168.0.9'});
      return {applied: out.applied, refused: out.refused, cls,
              hex: arcs.classColour(cls) ? arcs.classColour(cls).getHex() : null};
    }""")
    refused = result["refused"]
    ok = (result["applied"] == 2 and len(refused) == 1 and refused[0]["index"] == 1
          and result["cls"] == "rule2")
    return report(
        "3: a malformed rule does not cost the good ones", ok,
        f"applied {result['applied']}, refused {refused}, "
        f"the third row draws as {result['cls']}")


def country_case(page) -> bool:
    """A country rule fires on the live feed.

    Every other case spawns its own event. This one waits for the feed,
    because the field a country rule reads (`sc`/`dc`) is filled in by the
    collector and nothing in the renderer would notice if it stopped
    arriving.
    """
    result = page.evaluate("""async (cap) => {
      const {arcs} = window.__netviz;
      const m = await import('./js/config.js');
      // DE is one of the synthetic feed's ambient countries. On a real
      // deployment this case is about whatever that feed carries.
      m.CONFIG.arcs.rules = [{match: 'DE', colour: '#ff00ff'}];
      arcs.setRules(m.CONFIG.arcs.rules);
      const want = arcs.classColour('rule1').getHex();
      const t0 = performance.now();
      while (performance.now() - t0 < cap * 1000) {
        await new Promise((r) => setTimeout(r, 200));
        const n = arcs.group.children.filter(
          (mesh) => mesh.visible
                 && mesh.material.uniforms.color.value.getHex() === want).length;
        if (n > 0) return {n, waited: (performance.now() - t0) / 1000};
      }
      return {n: 0, waited: (performance.now() - t0) / 1000};
    }""", COUNTRY_CAP_SECONDS)
    return report(
        "4: a country rule fires on the live feed", result["n"] > 0,
        f"{result['n']} arc(s) on the rule after {result['waited']:.1f}s")


def run(page) -> bool:
    ok = True
    ok &= live_recolour_case(page)
    ok &= block_immunity_case(page)
    ok &= refusal_case(page)
    ok &= country_case(page)
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
