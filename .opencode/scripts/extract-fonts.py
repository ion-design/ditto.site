#!/usr/bin/env python3
"""
extract-fonts.py — Parse @font-face rules from captured CSS, resolve URLs, download,
and write license_hint into the manifest.

Run after capture.py and before generation. Input: capture directory with fonts/*.json.
Output: writes font files into <public_dir>/fonts/ and an updated JSON summary.

Dependencies: httpx, tinycss2 (pip install httpx tinycss2).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

try:
    import httpx
    import tinycss2
except ImportError:
    print(json.dumps({"error": "Missing deps. pip install httpx tinycss2"}), file=sys.stderr)
    sys.exit(1)


LICENSED_HOSTS = re.compile(r"(use\.typekit\.net|fonts\.adobe\.com|fast\.fonts\.net|cloud\.typography\.com)")
OPEN_HOSTS = re.compile(r"(fonts\.googleapis\.com|fonts\.gstatic\.com)")


def sha1_8(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:8]


def classify(url: str) -> str:
    if LICENSED_HOSTS.search(url):
        return "licensed"
    if OPEN_HOSTS.search(url):
        return "open"
    return "unclear"


def parse_face_rules(css_text: str, base_url: str) -> list[dict]:
    out = []
    rules = tinycss2.parse_stylesheet(css_text, skip_comments=True, skip_whitespace=True)
    for rule in rules:
        if rule.type != "at-rule" or rule.lower_at_keyword != "font-face":
            continue
        block = tinycss2.parse_declaration_list(rule.content or [])
        face: dict = {}
        for decl in block:
            if decl.type != "declaration":
                continue
            name = decl.lower_name
            value = tinycss2.serialize(decl.value).strip().strip('"').strip("'")
            if name == "font-family":
                face["family"] = value
            elif name == "font-weight":
                face["weight"] = value
            elif name == "font-style":
                face["style"] = value
            elif name == "src":
                urls = re.findall(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", tinycss2.serialize(decl.value))
                face["urls"] = [urljoin(base_url, u) for u in urls]
        if face.get("family") and face.get("urls"):
            out.append(face)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-dir", required=True)
    parser.add_argument("--public-dir", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    capture_dir = Path(args.capture_dir)
    public_dir = Path(args.public_dir)
    fonts_out = public_dir / "fonts"
    fonts_out.mkdir(parents=True, exist_ok=True)

    face_dumps = list((capture_dir / "fonts").glob("*.json"))

    all_faces: list[dict] = []
    for dump in face_dumps:
        data = json.loads(dump.read_text())
        for entry in data if isinstance(data, list) else []:
            css = entry.get("cssText") or ""
            base = entry.get("baseUrl") or ""
            all_faces.extend(parse_face_rules(css, base))

    downloaded: list[dict] = []
    skipped: list[dict] = []

    with httpx.Client(follow_redirects=True) as client:
        for face in all_faces:
            family = face["family"]
            license_hint = "unclear"
            for url in face["urls"]:
                license_hint = classify(url)
                if license_hint == "licensed":
                    skipped.append({"family": family, "url": url, "reason": "licensed"})
                    break
                try:
                    ext = url.rsplit(".", 1)[-1].split("?", 1)[0].lower()
                    if ext not in ("woff2", "woff", "ttf", "otf"):
                        ext = "woff2"
                    fname = f"{sha1_8(url)}-{re.sub(r'[^a-z0-9]+', '-', family.lower())}.{ext}"
                    out_path = fonts_out / fname
                    r = client.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0 (compatible; IonCloneBot/1.0)"})
                    r.raise_for_status()
                    out_path.write_bytes(r.content)
                    downloaded.append({
                        "family": family,
                        "weight": face.get("weight"),
                        "style": face.get("style"),
                        "source_url": url,
                        "local_path": str(out_path),
                        "license_hint": license_hint,
                    })
                except Exception as e:
                    skipped.append({"family": family, "url": url, "reason": str(e)})

    result = {"downloaded": downloaded, "skipped": skipped}
    if args.json:
        print(json.dumps(result))
    else:
        print(f"downloaded={len(downloaded)} skipped={len(skipped)}")


if __name__ == "__main__":
    main()
