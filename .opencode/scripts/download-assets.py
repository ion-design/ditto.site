#!/usr/bin/env python3
"""
download-assets.py — Download all assets referenced in a capture meta.json (or manifest.json)
into <project>/public/assets/cloned/ using hash-based filenames.

Input: JSON file with `assets[]` of shape { type, source_url, local_path }.
Output (to --json stdout): { downloaded: [...], failed: [...], skipped: [...] }

Dependencies: httpx (pip install httpx).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import httpx
except ImportError:
    print(json.dumps({"error": "Missing dependencies. pip install httpx"}), file=sys.stderr)
    sys.exit(1)


LICENSED_FONT_HOST_RE = re.compile(r"(use\.typekit\.net|fonts\.adobe\.com|fast\.fonts\.net|cloud\.typography\.com)")
ROTATING_AUTH_RE = re.compile(r"[?&](token|signature|expires)=")
USER_AGENT = "Mozilla/5.0 (compatible; IonCloneBot/1.0)"


def download_one(client: httpx.Client, url: str, out_path: Path) -> str:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with client.stream("GET", url, timeout=30, headers={"User-Agent": USER_AGENT}) as r:
        r.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    return "downloaded"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="Path to meta.json or manifest.json")
    parser.add_argument("--public-dir", required=True, help="Path to <project>/public/assets/cloned")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    public_dir = Path(args.public_dir)
    public_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text())
    assets = manifest.get("assets", [])

    downloaded: list[str] = []
    failed: list[dict] = []
    skipped: list[dict] = []

    with httpx.Client(follow_redirects=True) as client:
        for a in assets:
            url = a.get("source_url")
            local_path = a.get("local_path")
            atype = a.get("type")
            if not url or not local_path:
                failed.append({"url": url, "reason": "malformed_asset"})
                continue

            if atype == "font" and LICENSED_FONT_HOST_RE.search(url):
                skipped.append({"url": url, "reason": "licensed_font_unclear"})
                continue

            if ROTATING_AUTH_RE.search(url):
                skipped.append({"url": url, "reason": "rotating_auth_token"})
                continue

            # local_path in the asset is relative to the project root; public-dir is
            # <project>/public/assets/cloned, so strip that prefix.
            rel = local_path
            for prefix in ("public/assets/cloned/", "assets/cloned/"):
                if rel.startswith(prefix):
                    rel = rel[len(prefix):]
                    break
            out_path = public_dir / rel

            try:
                download_one(client, url, out_path)
                downloaded.append(str(out_path))
            except httpx.HTTPError as e:
                failed.append({"url": url, "reason": str(e)})
            except Exception as e:
                failed.append({"url": url, "reason": str(e)})

    result = {"downloaded": downloaded, "failed": failed, "skipped": skipped}
    if args.json:
        print(json.dumps(result))
    else:
        print(f"downloaded={len(downloaded)} failed={len(failed)} skipped={len(skipped)}")


if __name__ == "__main__":
    main()
