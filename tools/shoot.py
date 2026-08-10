#!/usr/bin/env python3
"""Screenshot the kiosk page so the renderer can be checked without a display.

Starts the collector in synthetic mode, loads the page in headless Chromium,
waits for window.__netvizReady plus a settling delay so arcs and bloom have
something to show, then writes a PNG and reports any console errors.

    python3 tools/shoot.py screenshots/01-sphere.png
    python3 tools/shoot.py screenshots/02-arcs.png --settle 8

Uses port 8199 rather than 8099: the deployed netviz-collector container owns
8099 on this host, so a shoot must never assume that port is free.
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
PORT = int(os.environ.get("NETVIZ_SHOOT_PORT", "8199"))
URL = f"http://127.0.0.1:{PORT}/"


def shoot(args, url: str) -> int:
    """Load the page, wait for the scene, screenshot it, report the console."""
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                          "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": args.width, "height": args.height})
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}")
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.goto(url, wait_until="load")
        page.wait_for_function("window.__netvizReady === true", timeout=15_000)
        time.sleep(args.settle)
        live = page.evaluate(
            "() => (window.__netviz && window.__netviz.arcs)"
            " ? window.__netviz.arcs.liveCount() : None".replace("None", "null"))
        page.screenshot(path=str(args.out))
        browser.close()

    print(f"wrote {args.out} (live arcs: {live})")
    for line in errors:
        print(f"  console: {line}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--settle", type=float, default=4.0,
                    help="seconds to let events accumulate before the shot")
    ap.add_argument("--width", type=int, default=2560)
    ap.add_argument("--height", type=int, default=1440)
    ap.add_argument("--url", default=None,
                    help="shoot an already-running collector (e.g. the deployed "
                         "http://collector.example.lan:8099/) instead of starting a "
                         "synthetic one locally")
    ap.add_argument("--query", default="",
                    help="query string for the page, without the '?' "
                         "(e.g. --query rail=1 to shoot the right rail)")
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    suffix = f"?{args.query.lstrip('?')}" if args.query else ""

    if args.url:
        return shoot(args, args.url + suffix)

    env = dict(os.environ, PYTHONUNBUFFERED="1", NETVIZ_WS_PORT=str(PORT))
    collector = subprocess.Popen([sys.executable, "-m", "netviz.main", "--synthetic"],
                                 cwd=REPO, env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                 start_new_session=True)
    try:
        time.sleep(2.0)
        if collector.poll() is not None:
            sys.stderr.write(collector.stderr.read().decode())
            return 1

        return shoot(args, URL + suffix)
    finally:
        os.killpg(os.getpgid(collector.pid), signal.SIGTERM)
        collector.wait(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
