#!/usr/bin/env python3
"""Drive the browser UI end to end and capture the screenshots in docs/screenshots/.

    python scripts/screenshots.py [--base http://127.0.0.1:8765] [--user maya]
"""

import argparse
import json
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "config.json").read_text())
OUT = ROOT / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--user", default="maya")
    ap.add_argument("--question", default="How many days of PTO do I get per year, and do unused days carry over?")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.base)
        page.fill("#u", args.user)
        page.fill("#p", CFG["cognito"]["testPassword"])
        page.screenshot(path=str(OUT / "01-signin.png"))
        page.click("#signin")
        page.wait_for_selector("#kbs b", timeout=20000)
        page.wait_for_timeout(1500)  # conversations + long-term memory panel load
        page.screenshot(path=str(OUT / f"02-home-{args.user}.png"))

        page.fill("#q", args.question)
        page.click("#send")
        # Wait for the result (the "total N ms" line is appended after the result event).
        page.wait_for_selector("#trace .hint:text-matches('total \\\\d+ ms')", timeout=120000)
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / f"03-answer-{args.user}.png"), full_page=True)

        trace_text = page.inner_text("#trace")
        answer_text = page.inner_text("#messages .msg.assistant:last-child")
        print("TRACE PANEL:\n" + trace_text)
        print("\nANSWER:\n" + answer_text[:600])
        browser.close()
    print(f"\nscreenshots in {OUT}")


if __name__ == "__main__":
    main()
