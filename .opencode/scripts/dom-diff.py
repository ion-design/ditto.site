#!/usr/bin/env python3
"""
dom-diff.py — Structural diff between two DOM JSON snapshots produced by the
__CLONE_DUMP_COMPUTED__ walker. Used by the validate agent to surface concrete,
actionable issues to the generate agent (font sizes, missing elements, wrong
dimensions) instead of relying solely on PNG pixel diffs.

Inputs: --captured <captured DOM JSON>, --rendered <rendered DOM JSON>.
Optionally --root-selector to scope the comparison to a specific subtree
(typically a section's id or class), and --max-depth to cap recursion.

Output (JSON to stdout): {
  matched: <int>,
  missing_in_rendered: [{ path, tag, id, class, expected_h, expected_w }],
  extra_in_rendered:   [{ path, tag, id, class }],
  style_mismatches:    [{ path, property, expected, actual, severity }],
  size_mismatches:     [{ path, expected, actual, delta_pct }],
  issues:              [string, string, ...]   // top human-readable issues
}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Properties we treat as load-bearing for visual fidelity. Reported in this
# order in the human-readable `issues` list.
COMPARE_STYLE_PROPS = [
    "fontSize",
    "fontFamily",
    "fontWeight",
    "lineHeight",
    "color",
    "backgroundColor",
    "backgroundImage",
    "padding",
    "margin",
    "borderRadius",
    "boxShadow",
    "display",
    "flexDirection",
    "justifyContent",
    "alignItems",
    "gridTemplateColumns",
    "gap",
    "textAlign",
    "letterSpacing",
    "textTransform",
]

# How far apart two values can be before we flag them.
NUMERIC_TOLERANCE_PX = 2
SIZE_TOLERANCE_PCT = 5.0


def find_subtree(node: dict, selector: str | None) -> dict | None:
    if not selector:
        return node
    target = selector.lstrip("#.")
    is_id = selector.startswith("#")
    is_class = selector.startswith(".")

    def walk(n: dict) -> dict | None:
        if not isinstance(n, dict):
            return None
        attrs = n.get("attrs") or {}
        if is_id and attrs.get("id") == target:
            return n
        if is_class:
            cls = attrs.get("class") or ""
            if target in cls.split():
                return n
        if not is_id and not is_class:
            # Tag selector
            if n.get("tag") == target:
                return n
        for c in n.get("children") or []:
            r = walk(c)
            if r is not None:
                return r
        return None

    return walk(node)


def parse_px(v: str | None) -> float | None:
    if not v:
        return None
    m = re.match(r"^(-?\d+(?:\.\d+)?)px$", str(v).strip())
    if m:
        return float(m.group(1))
    return None


def normalize_style_value(v: str | None) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    s = re.sub(r"\s+", " ", s)
    return s


def style_close(prop: str, expected: str | None, actual: str | None) -> bool:
    if expected == actual:
        return True
    e_px = parse_px(expected)
    a_px = parse_px(actual)
    if e_px is not None and a_px is not None:
        return abs(e_px - a_px) <= NUMERIC_TOLERANCE_PX
    if normalize_style_value(expected) == normalize_style_value(actual):
        return True
    # backgroundImage: if both reference url(), only flag if the url paths differ
    if prop == "backgroundImage" and expected and actual:
        e_url = re.search(r"url\([^)]+\)", expected)
        a_url = re.search(r"url\([^)]+\)", actual)
        if e_url and a_url:
            return False  # both have urls but different — flag
        return False
    return False


def child_key(n: dict, idx: int) -> str:
    if not isinstance(n, dict):
        return f"text[{idx}]"
    tag = n.get("tag") or "?"
    attrs = n.get("attrs") or {}
    if attrs.get("id"):
        return f"{tag}#{attrs['id']}"
    return f"{tag}[{idx}]"


def compare(
    a: dict | None,
    b: dict | None,
    path: str,
    issues: list[dict],
    counters: dict,
    max_depth: int,
    depth: int = 0,
) -> None:
    if depth > max_depth:
        return

    if a is None and b is None:
        return
    if a is None or not isinstance(a, dict):
        return  # only flag when source had it
    if b is None or not isinstance(b, dict):
        # Element missing in rendered
        attrs = a.get("attrs") or {}
        bbox = a.get("bbox") or {}
        issues.append({
            "kind": "missing_in_rendered",
            "path": path,
            "tag": a.get("tag"),
            "id": attrs.get("id"),
            "class": attrs.get("class"),
            "expected_w": round(bbox.get("width") or 0, 1),
            "expected_h": round(bbox.get("height") or 0, 1),
        })
        counters["missing"] += 1
        return

    # Tag mismatch
    if a.get("tag") != b.get("tag"):
        attrs_a = a.get("attrs") or {}
        attrs_b = b.get("attrs") or {}
        issues.append({
            "kind": "tag_mismatch",
            "path": path,
            "expected_tag": a.get("tag"),
            "actual_tag": b.get("tag"),
            "expected_id": attrs_a.get("id"),
            "actual_id": attrs_b.get("id"),
        })
        counters["tag_mismatch"] += 1
        return

    counters["matched"] += 1

    # Style comparison
    ca = (a.get("computed") or {})
    cb = (b.get("computed") or {})
    for prop in COMPARE_STYLE_PROPS:
        ev, av = ca.get(prop), cb.get(prop)
        if ev is None and av is None:
            continue
        # If property only exists on rendered, that's a divergence too — but
        # we only flag when source explicitly set it (prevents noise).
        if ev is None:
            continue
        if not style_close(prop, ev, av):
            issues.append({
                "kind": "style_mismatch",
                "path": path,
                "property": prop,
                "expected": ev,
                "actual": av,
            })
            counters["style"] += 1

    # Size comparison
    ba = a.get("bbox") or {}
    bb = b.get("bbox") or {}
    ew, eh = ba.get("width") or 0, ba.get("height") or 0
    aw, ah = bb.get("width") or 0, bb.get("height") or 0
    if ew > 8 and eh > 8:
        wdelta = abs(ew - aw) / max(ew, 1) * 100
        hdelta = abs(eh - ah) / max(eh, 1) * 100
        if wdelta > SIZE_TOLERANCE_PCT or hdelta > SIZE_TOLERANCE_PCT:
            issues.append({
                "kind": "size_mismatch",
                "path": path,
                "expected": [round(ew, 1), round(eh, 1)],
                "actual": [round(aw, 1), round(ah, 1)],
                "delta_pct": round(max(wdelta, hdelta), 1),
            })
            counters["size"] += 1

    # Children — match by (tag, id) tuple when ids exist, else positional
    ka = a.get("children") or []
    kb = b.get("children") or []
    # Filter to element children (skip pure text)
    ka_el = [(i, c) for i, c in enumerate(ka) if isinstance(c, dict) and "tag" in c]
    kb_el = [(i, c) for i, c in enumerate(kb) if isinstance(c, dict) and "tag" in c]

    # Build a lookup of rendered children by id (cheap) and by (tag, idx) fallback
    used_b: set[int] = set()
    b_by_id: dict[str, int] = {}
    for j, (_, ch) in enumerate(kb_el):
        cid = (ch.get("attrs") or {}).get("id")
        if cid:
            b_by_id[cid] = j

    for ai, (_, ch) in enumerate(ka_el):
        a_id = (ch.get("attrs") or {}).get("id")
        match_idx = None
        if a_id and a_id in b_by_id and b_by_id[a_id] not in used_b:
            match_idx = b_by_id[a_id]
        elif ai < len(kb_el) and ai not in used_b:
            cand = kb_el[ai][1]
            if cand.get("tag") == ch.get("tag"):
                match_idx = ai
        if match_idx is None:
            compare(ch, None, f"{path} > {child_key(ch, ai)}", issues, counters, max_depth, depth + 1)
        else:
            used_b.add(match_idx)
            compare(ch, kb_el[match_idx][1], f"{path} > {child_key(ch, ai)}", issues, counters, max_depth, depth + 1)

    # Extra children in rendered (no source counterpart) — only flag at top levels
    # to avoid noise from minor wrappers
    if depth < 3:
        for j, (_, ch) in enumerate(kb_el):
            if j in used_b:
                continue
            attrs = ch.get("attrs") or {}
            issues.append({
                "kind": "extra_in_rendered",
                "path": f"{path} > {child_key(ch, j)}",
                "tag": ch.get("tag"),
                "id": attrs.get("id"),
                "class": attrs.get("class"),
            })
            counters["extra"] += 1


def humanize(issues: list[dict], top_n: int = 12) -> list[str]:
    """Convert structured issues to human-readable strings, ranked by impact."""
    # Rank: missing > tag_mismatch > size_mismatch > style_mismatch > extra
    weights = {"missing_in_rendered": 100, "tag_mismatch": 80, "size_mismatch": 50, "style_mismatch": 25, "extra_in_rendered": 10}
    style_weights = {"backgroundImage": 4, "fontSize": 3, "color": 2, "backgroundColor": 2, "fontFamily": 2}

    def score(i: dict) -> float:
        base = weights.get(i["kind"], 0)
        if i["kind"] == "size_mismatch":
            base += min(i.get("delta_pct", 0), 50)
        if i["kind"] == "style_mismatch":
            base += style_weights.get(i.get("property", ""), 1)
        return base

    issues_sorted = sorted(issues, key=score, reverse=True)
    out: list[str] = []
    for i in issues_sorted[:top_n]:
        path = i.get("path", "?")
        if i["kind"] == "missing_in_rendered":
            out.append(f"{path}: missing in rendered (expected {i.get('tag')}{' #' + i['id'] if i.get('id') else ''}, ~{i.get('expected_w')}x{i.get('expected_h')})")
        elif i["kind"] == "tag_mismatch":
            out.append(f"{path}: expected <{i.get('expected_tag')}>, rendered <{i.get('actual_tag')}>")
        elif i["kind"] == "size_mismatch":
            ew, eh = i.get("expected", [0, 0])
            aw, ah = i.get("actual", [0, 0])
            out.append(f"{path}: size {aw}x{ah}, should be {ew}x{eh} (Δ{i.get('delta_pct')}%)")
        elif i["kind"] == "style_mismatch":
            out.append(f"{path}: {i.get('property')} is {i.get('actual')}, should be {i.get('expected')}")
        elif i["kind"] == "extra_in_rendered":
            out.append(f"{path}: extra element in rendered (<{i.get('tag')}>{' #' + i['id'] if i.get('id') else ''}) — not in source")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--captured", required=True)
    parser.add_argument("--rendered", required=True)
    parser.add_argument("--root-selector", default=None, help="e.g. #hero or .ecosystem to scope the diff to a section")
    parser.add_argument("--max-depth", type=int, default=8)
    parser.add_argument("--max-issues", type=int, default=200)
    args = parser.parse_args()

    captured = json.loads(Path(args.captured).read_text())
    rendered = json.loads(Path(args.rendered).read_text())

    a_root = find_subtree(captured, args.root_selector)
    b_root = find_subtree(rendered, args.root_selector)

    if a_root is None:
        print(json.dumps({"error": f"root selector not found in captured: {args.root_selector}"}))
        sys.exit(2)
    if b_root is None:
        print(json.dumps({"error": f"root selector not found in rendered: {args.root_selector}"}))
        sys.exit(3)

    issues: list[dict] = []
    counters = {"matched": 0, "missing": 0, "extra": 0, "tag_mismatch": 0, "style": 0, "size": 0}
    compare(a_root, b_root, args.root_selector or a_root.get("tag", "body"), issues, counters, args.max_depth)

    issues = issues[: args.max_issues]
    humanized = humanize(issues, top_n=12)

    print(json.dumps({
        "matched": counters["matched"],
        "counts": counters,
        "issues": humanized,
        "structured_issues": issues,
    }))


if __name__ == "__main__":
    main()
