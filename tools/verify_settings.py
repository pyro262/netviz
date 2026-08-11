"""Toggle the rail through applySettings and measure what the renderer did.

The three apply strategies are only really testable against a GPU: `relayout`
is the one that resizes the drawing buffer and corrects the camera aspect, and
those numbers are the whole point of the strategy existing.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("NETVIZ_VERIFY_PORT", "8399"))


def measure(page):
    return page.evaluate("""() => {
      const n = window.__netviz;
      const c = n.renderer.domElement;
      return {w: c.width, h: c.height, aspect: +n.camera.aspect.toFixed(3),
              rail: document.body.classList.contains('rail')};
    }""")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
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
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                        "--enable-unsafe-swiftshader"])
            page = b.new_page(viewport={"width": 2560, "height": 1440})
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                    if m.type == "error" else None)
            page.goto(url, wait_until="load")
            page.wait_for_function("window.__netvizReady === true", timeout=20_000)
            time.sleep(1.0)

            print("rail off:", measure(page))
            page.evaluate("() => window.__netviz.settings.apply({'rail.enabled': true})")
            time.sleep(0.5)
            print("rail on :", measure(page))
            page.evaluate("() => window.__netviz.settings.apply({'rail.enabled': false})")
            time.sleep(0.5)
            print("rail off:", measure(page))

            out = page.evaluate(
                "() => window.__netviz.settings.apply({'arcs.bodyOpacity': 'thick'})")
            print("rejected:", out)
            b.close()
    finally:
        if col:
            col.terminate()

    print("errors:", errors[:5] or "none")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
