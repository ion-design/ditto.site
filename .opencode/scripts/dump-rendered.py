#!/usr/bin/env python3
"""
dump-rendered.py — Open a URL (typically the local dev server) and dump its DOM
using the same __CLONE_DUMP_COMPUTED__ walker the capture pipeline uses for the
source. This produces a directly-comparable structural snapshot the validate
agent can diff against the captured original.

Usage:
  dump-rendered.py --url http://localhost:3000/ --output workspace/rendered/1280-step-00.json \
      --viewport 1280 --scroll-y 0

Dependencies: playwright.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print(json.dumps({"error": "Missing dependencies. pip install playwright && playwright install chromium"}), file=sys.stderr)
    sys.exit(1)


def load_init_hooks(hooks_dir: Path) -> list[str]:
    sources: list[str] = []
    # We only need computed-styles + section-scan for rendered-DOM purposes.
    for name in ("bootstrap.js", "computed-styles.js", "section-scan.js"):
        p = hooks_dir / name
        if p.exists():
            sources.append(p.read_text())
    return sources


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True, help="Path to write the rendered DOM JSON")
    parser.add_argument("--viewport", type=int, default=1280)
    parser.add_argument("--viewport-height", type=int, default=None, help="Default: 16:9 of viewport width")
    parser.add_argument("--scroll-y", type=int, default=0)
    parser.add_argument("--reduce-motion", action="store_true")
    parser.add_argument("--settle-ms", type=int, default=800)
    args = parser.parse_args()

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    height = args.viewport_height or round(args.viewport * 9 / 16)
    script_dir = Path(__file__).resolve().parent
    init_sources = load_init_hooks(script_dir / "init-hooks")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(viewport={"width": args.viewport, "height": height})
        for src in init_sources:
            ctx.add_init_script(src)
        page = ctx.new_page()

        try:
            page.goto(args.url, wait_until="networkidle", timeout=30_000)
        except PWTimeout:
            page.goto(args.url, wait_until="domcontentloaded", timeout=30_000)

        if args.reduce_motion:
            try:
                page.evaluate("document.documentElement.classList.add('reduce-motion')")
            except Exception:
                pass

        try:
            page.evaluate("() => document.fonts.ready")
        except Exception:
            pass

        try:
            page.wait_for_function("window.__CLONE_READY__ === true", timeout=5_000)
        except Exception:
            pass

        if args.scroll_y:
            page.evaluate(f"window.scrollTo({{ top: {args.scroll_y}, behavior: 'instant' }})")

        time.sleep(args.settle_ms / 1000.0)

        snapshot = page.evaluate(
            "() => (typeof window.__CLONE_DUMP_COMPUTED__ === 'function') ? window.__CLONE_DUMP_COMPUTED__() : null"
        )
        sections = page.evaluate(
            "() => (typeof window.__CLONE_LIST_SECTIONS__ === 'function') ? window.__CLONE_LIST_SECTIONS__() : []"
        ) or []

        if snapshot is None:
            raise SystemExit("dump-rendered: __CLONE_DUMP_COMPUTED__ unavailable — init hooks failed to load")

        output.write_text(json.dumps(snapshot, separators=(",", ":")))
        sections_path = output.with_name(output.stem + "-sections.json")
        sections_path.write_text(json.dumps(sections, indent=2))

        page.close()
        ctx.close()
        browser.close()

    print(json.dumps({
        "status": "ok",
        "output": str(output),
        "sections_path": str(sections_path),
        "section_count": len(sections),
    }))


if __name__ == "__main__":
    main()
