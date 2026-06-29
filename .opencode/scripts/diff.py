#!/usr/bin/env python3
"""
diff.py — Pixel diff two PNGs, producing a highlighted diff image and stats.

Uses the `pixelmatch` Python port (pip install pixelmatch pillow). Returns JSON to stdout:
  { diff_pct, diff_image_path, worst_regions: [ { x, y, width, height } ] }

Worst regions are computed via connected-component analysis on the diff mask, sorted by area desc.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
    from pixelmatch.contrib.PIL import pixelmatch
except ImportError:
    print(json.dumps({"error": "Missing dependencies. pip install pixelmatch pillow numpy"}), file=sys.stderr)
    sys.exit(1)

try:
    import numpy as np
    from scipy import ndimage
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False


def resize_to_match(a: Image.Image, b: Image.Image) -> tuple[Image.Image, Image.Image]:
    if a.size == b.size:
        return a, b
    target = (min(a.size[0], b.size[0]), min(a.size[1], b.size[1]))
    return a.resize(target), b.resize(target)


def worst_regions_from_diff(diff_img: Image.Image, top_n: int = 5) -> list[dict]:
    if not HAVE_SCIPY:
        return []
    arr = np.array(diff_img)
    if arr.ndim == 3:
        mask = (arr[..., :3].sum(axis=-1) > 0).astype(np.uint8)
    else:
        mask = (arr > 0).astype(np.uint8)
    labels, n = ndimage.label(mask)
    if n == 0:
        return []
    regions = []
    for i in range(1, n + 1):
        ys, xs = np.where(labels == i)
        if len(xs) < 20:
            continue
        regions.append({
            "x": int(xs.min()),
            "y": int(ys.min()),
            "width": int(xs.max() - xs.min() + 1),
            "height": int(ys.max() - ys.min() + 1),
            "area": int(len(xs)),
        })
    regions.sort(key=lambda r: r["area"], reverse=True)
    out = []
    for r in regions[:top_n]:
        r.pop("area", None)
        out.append(r)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--diff-out", required=True)
    parser.add_argument("--threshold", type=float, default=0.1)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    a = Image.open(args.before).convert("RGBA")
    b = Image.open(args.after).convert("RGBA")
    a, b = resize_to_match(a, b)
    diff = Image.new("RGBA", a.size, (0, 0, 0, 0))

    mismatched = pixelmatch(a, b, diff, threshold=args.threshold, includeAA=False)
    total = a.size[0] * a.size[1]
    diff_pct = (mismatched / total) * 100.0 if total else 0.0

    Path(args.diff_out).parent.mkdir(parents=True, exist_ok=True)
    diff.save(args.diff_out)

    worst = worst_regions_from_diff(diff)

    result = {
        "diff_pct": round(diff_pct, 3),
        "diff_image_path": args.diff_out,
        "worst_regions": worst,
        "size": {"width": a.size[0], "height": a.size[1]},
    }
    if args.json:
        print(json.dumps(result))
    else:
        print(f"diff_pct={result['diff_pct']}% diff_image={result['diff_image_path']} regions={len(worst)}")


if __name__ == "__main__":
    main()
