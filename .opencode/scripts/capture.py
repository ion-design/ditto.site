#!/usr/bin/env python3
"""
capture.py — Playwright-based site capture for the clone pipeline.

Produces a full capture bundle at --output. Layout is documented in
.opencode/skills/site-manifest/SKILL.md and consumed by the analyze + generate
agents.

Pipeline:
  Stage 0: Per-viewport scroll-loop capture — DOM + computed styles, screenshots,
           HAR, animation library dumps, fonts, css-vars, css-rules.
  Stage 1: Alt-height capture at the canonical desktop width (1280) for
           vh-relative detection.
  Stage 2: Per-section cropped screenshot pass — scroll each candidate section
           into view and crop to its bbox.
  Stage 3: Post-process — derive vh-relative flags, merge HAR + CSS asset URLs,
           write meta.json.

Replay mode: --replay skips stages 0-2 and only re-runs stage 3 against existing
capture data. Use this when iterating on prompts/agents/skills without paying the
~3-minute capture cost again.

Dependencies: playwright (pip install playwright && playwright install chromium)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print(json.dumps({"error": "Missing dependencies. pip install playwright && playwright install chromium"}), file=sys.stderr)
    sys.exit(1)


THIRD_PARTY_HOST_RE = re.compile(
    r"(intercom\.io|driftt\.com|drift\.com|typeform\.com|calendly\.com|hsforms\.(net|com)|"
    r"cookielaw\.org|cookiebot\.com|osano\.com|googletagmanager\.com|google-analytics\.com|"
    r"segment\.(io|com)|hotjar\.com|fullstory\.com)"
)

# Viewport that the analyze agent treats as canonical desktop. We capture a second
# DOM dump at this width but a different height to detect vh-relative dimensions.
CANONICAL_WIDTH = 1280
CANONICAL_HEIGHT_PRIMARY = 720
CANONICAL_HEIGHT_ALT = 1080


def sha1_8(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:8]


def sanitize(name: str) -> str:
    name = name.lower()
    name = re.sub(r"\s+", "-", name)
    name = re.sub(r"[^a-z0-9.\-]", "", name)
    return name[:80] or "asset"


def load_init_hooks(hooks_dir: Path) -> list[str]:
    sources: list[str] = []
    for path in sorted(hooks_dir.glob("*.js")):
        sources.append(path.read_text())
    return sources


def asset_type_from_url(url: str, content_type: str | None) -> str | None:
    u = url.lower().split("?", 1)[0]
    ct = (content_type or "").lower()
    # SVG must be checked before generic image/* — content-type "image/svg+xml" matches both.
    if u.endswith(".svg") or ct == "image/svg+xml":
        return "svg"
    if any(u.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif")) or ct.startswith("image/"):
        return "image"
    if any(u.endswith(ext) for ext in (".mp4", ".mov", ".webm")) or ct.startswith("video/"):
        return "video"
    if any(u.endswith(ext) for ext in (".woff2", ".woff", ".ttf", ".otf")) or ct in (
        "font/woff2", "font/woff", "font/ttf", "application/font-woff2", "application/font-woff", "application/x-font-ttf"
    ):
        return "font"
    if u.endswith(".json") and ("lottie" in u or "animations" in u):
        return "lottie"
    return None


def asset_type_from_url_only(url: str) -> str | None:
    return asset_type_from_url(url, None)


def viewport_height_for(width: int) -> int:
    """Default capture height — 16:9 ratio, but rounded sensibly."""
    return round(width * 9 / 16)


# ---------------------------------------------------------------------------
# Browser helpers
# ---------------------------------------------------------------------------


def make_context(browser, viewport_w: int, viewport_h: int, har_path: Path | None, init_sources: list[str], skip_third_party: bool):
    ctx_kwargs = {"viewport": {"width": viewport_w, "height": viewport_h}}
    if har_path is not None:
        ctx_kwargs["record_har_path"] = str(har_path)
    ctx = browser.new_context(**ctx_kwargs)

    if skip_third_party:
        def route_handler(route):
            if THIRD_PARTY_HOST_RE.search(route.request.url):
                route.abort()
            else:
                route.continue_()
        ctx.route("**/*", route_handler)

    for src in init_sources:
        ctx.add_init_script(src)

    return ctx


def goto_and_settle(page, url: str, wait_strategy: str) -> None:
    try:
        page.goto(url, wait_until=wait_strategy, timeout=60_000)
    except PWTimeout:
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)

    try:
        page.evaluate("() => document.fonts.ready")
    except Exception:
        pass

    try:
        page.wait_for_function("window.__CLONE_READY__ === true", timeout=10_000)
    except Exception:
        pass


def dump_dom(page) -> dict:
    """Use the rich __CLONE_DUMP_COMPUTED__ walker (which filters per-tag defaults
    and captures pseudo-elements). Falls back to a minimal walk if the hook
    didn't load."""
    try:
        out = page.evaluate("() => (typeof window.__CLONE_DUMP_COMPUTED__ === 'function') ? window.__CLONE_DUMP_COMPUTED__() : null")
        if out is not None:
            return out
    except Exception:
        pass
    return page.evaluate(
        """() => {
            const serialize = (el) => {
                if (el.nodeType === Node.TEXT_NODE) {
                    const t = el.textContent;
                    return t && t.trim() ? { text: t } : null;
                }
                if (el.nodeType !== Node.ELEMENT_NODE) return null;
                const cs = getComputedStyle(el);
                const computed = {};
                for (const p of ['color','backgroundColor','backgroundImage','fontFamily','fontSize','fontWeight','lineHeight','display','width','height','padding','margin','position']) {
                    const v = cs[p];
                    if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') computed[p] = v;
                }
                const attrs = {};
                for (const a of el.attributes) attrs[a.name] = a.value;
                const r = el.getBoundingClientRect();
                const children = [];
                for (const c of el.childNodes) { const s = serialize(c); if (s) children.push(s); }
                return {
                    tag: el.tagName.toLowerCase(),
                    attrs,
                    computed,
                    bbox: { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height },
                    children,
                };
            };
            return serialize(document.body);
        }"""
    )


def list_sections(page) -> list[dict]:
    try:
        return page.evaluate("() => (typeof window.__CLONE_LIST_SECTIONS__ === 'function') ? window.__CLONE_LIST_SECTIONS__() : []") or []
    except Exception:
        return []


def smart_scroll_targets(sections: list[dict], page_height: int, viewport_h: int) -> list[int]:
    """Compute scroll y positions to visit. We always include 0 (top), then
    each section's y minus a small offset, deduped. Also fill any gap larger
    than 1.5x viewport_h with intermediate stops so we don't skip content
    between sections.
    """
    raw = [0]
    for sec in sections:
        y = max(int(sec.get("y") or 0) - 80, 0)
        raw.append(y)
    raw.append(max(page_height - viewport_h, 0))

    # Sort + dedupe + fill gaps
    raw = sorted(set(raw))
    filled: list[int] = []
    for i, y in enumerate(raw):
        if filled and y - filled[-1] > int(viewport_h * 1.5):
            mid = filled[-1] + viewport_h
            while mid < y - viewport_h:
                filled.append(mid)
                mid += viewport_h
        filled.append(y)
    # Cap to avoid pathological cases
    return filled[:50]


def settle(page, max_ms: int = 1500) -> None:
    """Wait for the layout to settle: networkidle attempt + a short fixed delay
    + waitForFunction on document.fonts.ready. If a MutationObserver fires
    rapidly, we yield more time up to max_ms."""
    deadline = time.monotonic() + (max_ms / 1000.0)
    try:
        page.wait_for_load_state("networkidle", timeout=max(int(max_ms / 2), 500))
    except Exception:
        pass
    remaining = deadline - time.monotonic()
    if remaining > 0:
        # Watch for mutation activity; if quiet for 250ms, return
        try:
            page.evaluate(
                """async (maxMs) => {
                    return await new Promise((resolve) => {
                        let lastMutation = performance.now();
                        const start = lastMutation;
                        const obs = new MutationObserver(() => { lastMutation = performance.now(); });
                        obs.observe(document.body, { subtree: true, childList: true, attributes: true });
                        const tick = () => {
                            const now = performance.now();
                            if (now - lastMutation > 250 || now - start > maxMs) { obs.disconnect(); resolve(true); }
                            else requestAnimationFrame(tick);
                        };
                        tick();
                    });
                }""",
                int(remaining * 1000),
            )
        except Exception:
            time.sleep(min(remaining, 0.5))


# ---------------------------------------------------------------------------
# Stage 0 — per-viewport scroll-loop capture
# ---------------------------------------------------------------------------


def capture_viewport(
    browser,
    viewport_width: int,
    url: str,
    wait_strategy: str,
    init_sources: list[str],
    output_dir: Path,
    skip_third_party: bool,
) -> dict:
    viewport_height = viewport_height_for(viewport_width)
    vp_dir = output_dir / "screenshots" / str(viewport_width)
    dom_dir = output_dir / "dom" / str(viewport_width)
    har_dir = output_dir / "har"
    for d in (vp_dir, dom_dir, har_dir):
        d.mkdir(parents=True, exist_ok=True)

    har_path = har_dir / f"{viewport_width}.har"
    page_context = make_context(browser, viewport_width, viewport_height, har_path, init_sources, skip_third_party)

    page = page_context.new_page()
    discovered_assets: dict[str, dict] = {}

    def on_response(response):
        try:
            url_ = response.url
            content_type = response.headers.get("content-type")
            t = asset_type_from_url(url_, content_type)
            if t is None:
                return
            if url_ in discovered_assets:
                return
            discovered_assets[url_] = {
                "type": t,
                "source_url": url_,
                "content_type": content_type,
                "status": response.status,
            }
        except Exception:
            pass

    page.on("response", on_response)
    goto_and_settle(page, url, wait_strategy)

    sections = list_sections(page)
    page_height = page.evaluate("() => document.documentElement.scrollHeight") or 0
    targets = smart_scroll_targets(sections, page_height, viewport_height)

    for step, y in enumerate(targets):
        page.evaluate(f"window.scrollTo({{ top: {y}, behavior: 'instant' }})")
        settle(page, max_ms=1200)
        page.screenshot(path=str(vp_dir / f"step-{step:02d}.png"), full_page=False)
        snapshot = dump_dom(page)
        (dom_dir / f"step-{step:02d}.json").write_text(json.dumps(snapshot, separators=(",", ":")))

    # Pull animation/css-rules hook output
    hook_output = page.evaluate("() => window.__CLONE_CAPTURE__ || {}") or {}
    for kind in ("shaders", "gsap", "framer", "lottie", "threejs"):
        d = output_dir / kind
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{viewport_width}.json").write_text(json.dumps(hook_output.get(kind, []), indent=2))
    for kind, dirname in (("cssVars", "css-vars"), ("fonts", "fonts"), ("cssRules", "css-rules")):
        d = output_dir / dirname
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{viewport_width}.json").write_text(json.dumps(hook_output.get(kind, {}), indent=2))

    # Dump candidate sections per viewport (analyze agent uses these)
    sec_dir = output_dir / "sections"
    sec_dir.mkdir(parents=True, exist_ok=True)
    (sec_dir / f"{viewport_width}.json").write_text(json.dumps(sections, indent=2))

    # Hover capture
    try:
        hover_rects = page.evaluate(
            """() => {
                const els = document.querySelectorAll('a, button, [role="button"], [data-cta]');
                const out = [];
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (r.width < 40 || r.height < 20) continue;
                    out.push({ x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName });
                    if (out.length >= 10) break;
                }
                return out;
            }"""
        )
        hover_dir = output_dir / "screenshots" / str(viewport_width) / "hover"
        hover_dir.mkdir(parents=True, exist_ok=True)
        for idx, pos in enumerate(hover_rects):
            try:
                page.mouse.move(pos["x"], pos["y"])
                time.sleep(0.2)
                page.screenshot(path=str(hover_dir / f"hover-{idx:02d}.png"), full_page=False)
            except Exception:
                continue
    except Exception:
        pass

    page.close()
    page_context.close()

    return {
        "viewport": viewport_width,
        "height": viewport_height,
        "steps": len(targets),
        "section_candidates": len(sections),
        "hook_output_keys": [k for k in hook_output.keys()],
        "har": str(har_path.relative_to(output_dir)),
        "assets": discovered_assets,
    }


# ---------------------------------------------------------------------------
# Stage 1 — alt-height capture at canonical width (vh detection)
# ---------------------------------------------------------------------------


def capture_alt_height(browser, url: str, wait_strategy: str, init_sources: list[str], output_dir: Path, skip_third_party: bool) -> dict:
    """Capture only DOM at scroll 0 at (CANONICAL_WIDTH x CANONICAL_HEIGHT_ALT).
    The post-process compares this to the primary capture to flag vh-relative
    dimensions."""
    page_context = make_context(browser, CANONICAL_WIDTH, CANONICAL_HEIGHT_ALT, None, init_sources, skip_third_party)
    page = page_context.new_page()
    goto_and_settle(page, url, wait_strategy)
    settle(page, max_ms=1200)
    snapshot = dump_dom(page)
    sections = list_sections(page)

    out_dir = output_dir / "dom-alt" / f"{CANONICAL_WIDTH}-{CANONICAL_HEIGHT_ALT}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "step-00.json").write_text(json.dumps(snapshot, separators=(",", ":")))
    (out_dir / "sections.json").write_text(json.dumps(sections, indent=2))

    page.close()
    page_context.close()
    return {"viewport": CANONICAL_WIDTH, "alt_height": CANONICAL_HEIGHT_ALT, "section_candidates": len(sections)}


# ---------------------------------------------------------------------------
# Stage 2 — per-section cropped screenshots
# ---------------------------------------------------------------------------


def capture_section_screenshots(browser, url: str, wait_strategy: str, init_sources: list[str], output_dir: Path, skip_third_party: bool, viewport_widths: list[int]) -> int:
    """For each viewport width, scroll each candidate section into view and
    save a screenshot cropped to its bbox. The analyze agent maps these to
    section ids; the validate agent uses them as the diff reference."""
    total = 0
    for vw in viewport_widths:
        sections_path = output_dir / "sections" / f"{vw}.json"
        if not sections_path.exists():
            continue
        sections = json.loads(sections_path.read_text())
        if not sections:
            continue
        vh = viewport_height_for(vw)
        page_context = make_context(browser, vw, vh, None, init_sources, skip_third_party)
        page = page_context.new_page()
        goto_and_settle(page, url, wait_strategy)
        out_dir = output_dir / "section-shots" / str(vw)
        out_dir.mkdir(parents=True, exist_ok=True)
        for idx, sec in enumerate(sections):
            try:
                # Scroll so the section's top is ~80px below the viewport top
                target_y = max(int(sec.get("y") or 0) - 80, 0)
                page.evaluate(f"window.scrollTo({{ top: {target_y}, behavior: 'instant' }})")
                settle(page, max_ms=1000)
                clip = {
                    "x": max(int(sec.get("x") or 0), 0),
                    "y": max(int(sec.get("y") or 0) - target_y, 0),
                    "width": min(int(sec.get("width") or vw), vw),
                    "height": min(int(sec.get("height") or vh), vh * 4),
                }
                # Playwright clip cannot exceed the page viewport vertically; if the section is
                # taller than the viewport, capture as-is and analyze handles the partial.
                clip["height"] = min(clip["height"], vh)
                page.screenshot(path=str(out_dir / f"section-{idx:02d}.png"), clip=clip)
                total += 1
            except Exception:
                continue
        page.close()
        page_context.close()
    return total


# ---------------------------------------------------------------------------
# Stage 3 — post-process: build assets list, derive vh flags, write meta.json
# ---------------------------------------------------------------------------


def merge_css_assets(output_dir: Path, har_assets: dict[str, dict]) -> dict[str, dict]:
    """Walk css-rules/<vp>.json across viewports, append every url() reference
    not already in har_assets. Type is inferred from the URL alone since CSS
    references don't carry content-type."""
    merged = dict(har_assets)
    css_rules_dir = output_dir / "css-rules"
    if css_rules_dir.exists():
        for f in css_rules_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text())
            except Exception:
                continue
            for asset in data.get("assets", []) or []:
                src = asset.get("source_url")
                if not src or src in merged:
                    continue
                t = asset_type_from_url_only(src)
                if t is None:
                    continue
                merged[src] = {
                    "type": t,
                    "source_url": src,
                    "content_type": None,
                    "status": None,
                    "from_css": True,
                }
    return merged


def build_assets_list(all_assets: dict[str, dict]) -> list[dict]:
    out = []
    for url, a in all_assets.items():
        name = sanitize(unquote(os.path.basename(urlparse(url).path)) or "asset")
        local_path = f"public/assets/cloned/{a['type']}s/{sha1_8(url)}-{name}"
        entry = {
            "type": a["type"],
            "source_url": url,
            "local_path": local_path,
        }
        if a.get("from_css"):
            entry["from_css"] = True
        out.append(entry)
    return out


def detect_vh_flags(output_dir: Path) -> list[dict]:
    """Compare DOM at (1280x720) vs (1280x1080). For each element matchable by
    structural path, if `h_alt / h_primary ≈ alt_height / primary_height`, flag
    it as vh-relative and record the implied vh percentage.
    Output: a flat list of { path, primary_h, alt_h, vh } entries.
    """
    primary = output_dir / "dom" / str(CANONICAL_WIDTH) / "step-00.json"
    alt = output_dir / "dom-alt" / f"{CANONICAL_WIDTH}-{CANONICAL_HEIGHT_ALT}" / "step-00.json"
    if not primary.exists() or not alt.exists():
        return []
    try:
        a = json.loads(primary.read_text())
        b = json.loads(alt.read_text())
    except Exception:
        return []

    expected_ratio = CANONICAL_HEIGHT_ALT / CANONICAL_HEIGHT_PRIMARY  # 1.5
    tolerance = 0.06  # 6% — accounts for content-driven elements that happen to be near vh

    flags: list[dict] = []

    def walk(na, nb, path):
        if not isinstance(na, dict) or not isinstance(nb, dict):
            return
        if na.get("tag") != nb.get("tag"):
            return
        ha = (na.get("bbox") or {}).get("height") or 0
        hb = (nb.get("bbox") or {}).get("height") or 0
        if ha > 40 and hb > 40:
            ratio = hb / ha
            if abs(ratio - expected_ratio) / expected_ratio < tolerance:
                vh_pct = round((ha / CANONICAL_HEIGHT_PRIMARY) * 100)
                flags.append({
                    "path": path,
                    "tag": na.get("tag"),
                    "id": (na.get("attrs") or {}).get("id") or None,
                    "class": (na.get("attrs") or {}).get("class") or None,
                    "primary_h": round(ha, 2),
                    "alt_h": round(hb, 2),
                    "ratio": round(ratio, 3),
                    "vh": vh_pct,
                })
        ca = na.get("children") or []
        cb = nb.get("children") or []
        # Only walk matched element children; pair by tag-aware index
        ai = bi = 0
        idx = 0
        while ai < len(ca) and bi < len(cb):
            ea = ca[ai]
            eb = cb[bi]
            if not isinstance(ea, dict) or not isinstance(eb, dict) or ea.get("tag") != eb.get("tag"):
                # Skip text-only / mismatched
                if not isinstance(ea, dict) or "tag" not in ea:
                    ai += 1
                    continue
                if not isinstance(eb, dict) or "tag" not in eb:
                    bi += 1
                    continue
                # Different tags at same index — skip both
                ai += 1
                bi += 1
                continue
            walk(ea, eb, f"{path}>{ea.get('tag')}[{idx}]")
            ai += 1
            bi += 1
            idx += 1

    walk(a, b, a.get("tag", "body"))
    return flags


SECTION_LIKE_TAGS = {"section", "header", "footer", "nav", "main", "article", "aside"}
SECTION_CLASS_RE = re.compile(r"(section|hero|banner|elementor-element|e-parent|e-con|footer|header|nav|main)", re.I)
SECTION_ID_RE = re.compile(r"(hero|banner|section|footer|nav|header|main)", re.I)


def _is_section_like(node: dict) -> bool:
    tag = (node.get("tag") or "").lower()
    if tag in SECTION_LIKE_TAGS:
        return True
    attrs = node.get("attrs") or {}
    eid = attrs.get("id") or ""
    if eid and SECTION_ID_RE.search(eid):
        return True
    cls = attrs.get("class") or ""
    if cls and SECTION_CLASS_RE.search(cls):
        return True
    return False


def _is_visible(node: dict) -> bool:
    cs = node.get("computed") or {}
    if cs.get("display") == "none" or cs.get("visibility") == "hidden":
        return False
    op = cs.get("opacity")
    if op is not None and op != "":
        try:
            if float(op) == 0:
                return False
        except (TypeError, ValueError):
            pass
    return True


def _build_selector(node: dict) -> str:
    attrs = node.get("attrs") or {}
    if attrs.get("id"):
        return f"#{attrs['id']}"
    cls = (attrs.get("class") or "").strip().split()
    if cls:
        # First class is usually the most distinctive (Elementor style)
        return f"{node.get('tag')}.{cls[0]}"
    return node.get("tag") or "?"


def _walk_section_candidates(node: dict, vw: int, path: str, idx: int, out: list[dict]) -> None:
    if not isinstance(node, dict) or "tag" not in node:
        return
    cur_path = f"{path}>{node.get('tag')}[{idx}]" if path else (node.get("tag") or "?")
    bbox = node.get("bbox") or {}
    w = bbox.get("width") or 0
    h = bbox.get("height") or 0
    if _is_visible(node) and _is_section_like(node) and w >= vw * 0.5 and h >= 80:
        attrs = node.get("attrs") or {}
        out.append({
            "_path": cur_path,
            "_node": node,
            "selector": _build_selector(node),
            "tag": node.get("tag"),
            "id": attrs.get("id") or None,
            "className": (attrs.get("class") or "")[:200] or None,
            "x": round(bbox.get("x") or 0, 1),
            "y": round(bbox.get("y") or 0, 1),
            "width": round(w, 1),
            "height": round(h, 1),
        })
    for i, c in enumerate(node.get("children") or []):
        _walk_section_candidates(c, vw, cur_path, i, out)


def _outermost_wins(candidates: list[dict]) -> list[dict]:
    # Sort by path depth — shallowest first; only keep candidates that are not
    # descendants of an already-kept candidate.
    by_depth = sorted(candidates, key=lambda c: c["_path"].count(">"))
    kept: list[dict] = []
    for c in by_depth:
        if any(c["_path"].startswith(k["_path"] + ">") for k in kept):
            continue
        kept.append(c)
    return kept


def _expand_oversized(candidates: list[dict], vw: int, vh: int, doc_h: float) -> list[dict]:
    """For wrapper-shaped candidates (>2x viewport_h with >=3 inner sections),
    replace the wrapper with its section-like children. Without this step,
    Elementor / WP layouts where everything is wrapped in a single <main id="main">
    or <div class="elementor-section-wrap"> collapse to a single huge candidate
    and the smart-scroll loop never visits the actual sections."""
    threshold = max(vh * 2, doc_h * 0.5)
    expanded: list[dict] = []
    for c in candidates:
        if c["height"] < threshold:
            expanded.append(c)
            continue
        inner: list[dict] = []
        for i, child in enumerate(c["_node"].get("children") or []):
            _walk_section_candidates(child, vw, c["_path"], i, inner)
        inner = _outermost_wins(inner)
        # Recurse: an inner section may itself be an oversized wrapper.
        inner = _expand_oversized(inner, vw, vh, doc_h)
        if len(inner) >= 3:
            expanded.extend(inner)
        else:
            expanded.append(c)
    return expanded


def enrich_sections(output_dir: Path) -> int:
    """Re-derive sections/<vp>.json from the captured dom/<vp>/step-00.json so
    the JS section-scan's outermost-wins rule is corrected for wrapper-shaped
    layouts. Idempotent — safe to run in both fresh-capture and replay paths.
    Returns the total candidate count across viewports."""
    dom_root = output_dir / "dom"
    sec_root = output_dir / "sections"
    if not dom_root.exists():
        return 0
    sec_root.mkdir(parents=True, exist_ok=True)
    total = 0
    for vp_dir in sorted(dom_root.iterdir()):
        if not vp_dir.is_dir() or not vp_dir.name.isdigit():
            continue
        vp = int(vp_dir.name)
        step0 = vp_dir / "step-00.json"
        if not step0.exists():
            continue
        try:
            root = json.loads(step0.read_text())
        except Exception:
            continue
        doc_h = (root.get("bbox") or {}).get("height") or 0
        vh = viewport_height_for(vp)
        candidates: list[dict] = []
        _walk_section_candidates(root, vp, "", 0, candidates)
        kept = _outermost_wins(candidates)
        expanded = _expand_oversized(kept, vp, vh, doc_h)
        # Strip private fields, sort by y
        public = [{k: v for k, v in c.items() if not k.startswith("_")} for c in expanded]
        public = [s for s in public if s.get("height", 0) > 80]
        public.sort(key=lambda s: s.get("y") or 0)
        (sec_root / f"{vp}.json").write_text(json.dumps(public, indent=2))
        total += len(public)
    return total


def detect_libs(output_dir: Path) -> list[str]:
    libs_detected = set()
    for kind in ("gsap", "framer", "lottie", "three", "shaders"):
        dirname = "threejs" if kind == "three" else kind
        d = output_dir / dirname
        if not d.exists():
            continue
        for f in d.glob("*.json"):
            try:
                data = json.loads(f.read_text())
                if data:
                    libs_detected.add(kind)
                    break
            except Exception:
                continue
    return sorted(libs_detected)


def collect_har_assets_from_disk(output_dir: Path) -> dict[str, dict]:
    """Fallback for replay mode — read each har/<vp>.har and extract response URLs."""
    har_dir = output_dir / "har"
    out: dict[str, dict] = {}
    if not har_dir.exists():
        return out
    for f in har_dir.glob("*.har"):
        try:
            har = json.loads(f.read_text())
        except Exception:
            continue
        for entry in (har.get("log") or {}).get("entries", []):
            req = entry.get("request") or {}
            res = entry.get("response") or {}
            url = req.get("url")
            if not url:
                continue
            ct = None
            for h in (res.get("headers") or []):
                if (h.get("name") or "").lower() == "content-type":
                    ct = h.get("value")
                    break
            t = asset_type_from_url(url, ct)
            if t and url not in out:
                out[url] = {"type": t, "source_url": url, "content_type": ct, "status": res.get("status")}
    return out


def write_meta(output_dir: Path, source_url: str, viewports: list[int], per_viewport_summary: list[dict], all_assets: dict[str, dict]) -> Path:
    merged = merge_css_assets(output_dir, all_assets)
    assets_list = build_assets_list(merged)
    vh_flags = detect_vh_flags(output_dir)
    # Emit vh-flags.json at the workspace level (parent of capture/) so it lives next to manifest.json.
    if vh_flags:
        workspace_root = output_dir.parent
        (workspace_root / "vh-flags.json").write_text(json.dumps(vh_flags, indent=2))
    # Re-derive sections/<vp>.json from the DOM dumps. Replaces the JS section-scan
    # output with a Python pass that recurses into oversized wrappers (the JS hook
    # also has the recursion now, but Python being authoritative makes the fix
    # available in --replay mode against existing capture data).
    enriched_section_total = enrich_sections(output_dir)

    meta = {
        "source_url": source_url,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "viewports": viewports,
        "canonical_viewport": {"width": CANONICAL_WIDTH, "height": CANONICAL_HEIGHT_PRIMARY, "alt_height": CANONICAL_HEIGHT_ALT},
        "per_viewport": per_viewport_summary,
        "assets": assets_list,
        "asset_sources": {
            "har": sum(1 for a in assets_list if not a.get("from_css")),
            "css": sum(1 for a in assets_list if a.get("from_css")),
        },
        "libs_detected": detect_libs(output_dir),
        "dom_snapshots": sum(s.get("steps", 0) for s in per_viewport_summary),
        "screenshots": sum(s.get("steps", 0) for s in per_viewport_summary),
        "vh_relative_count": len(vh_flags),
        "section_shots": len(list((output_dir / "section-shots").rglob("*.png"))) if (output_dir / "section-shots").exists() else 0,
        "section_candidates_total": enriched_section_total,
        "canvas_regions": 0,
    }
    out_path = output_dir / "meta.json"
    out_path.write_text(json.dumps(meta, indent=2))
    return out_path


def replay(output_dir: Path, source_url: str | None) -> Path:
    """Replay mode: re-derive meta.json + vh-flags.json from existing capture data.
    Useful for iterating on the analyze/generate/validate agents without re-running
    the (slow) browser pipeline."""
    if not output_dir.exists():
        raise SystemExit(f"replay: output dir does not exist: {output_dir}")

    # Try existing meta.json for source_url + viewports
    existing_meta_path = output_dir / "meta.json"
    existing_meta = {}
    if existing_meta_path.exists():
        try:
            existing_meta = json.loads(existing_meta_path.read_text())
        except Exception:
            existing_meta = {}
    if not source_url:
        source_url = existing_meta.get("source_url") or "unknown://replay"

    # Infer viewports from existing dom/<vp>/ folders
    dom_root = output_dir / "dom"
    viewports: list[int] = []
    if dom_root.exists():
        for child in dom_root.iterdir():
            if child.is_dir() and child.name.isdigit():
                viewports.append(int(child.name))
    viewports.sort()

    per_viewport_summary: list[dict] = []
    for vp in viewports:
        steps = len(list((dom_root / str(vp)).glob("step-*.json")))
        sections_path = output_dir / "sections" / f"{vp}.json"
        section_count = 0
        if sections_path.exists():
            try:
                section_count = len(json.loads(sections_path.read_text()))
            except Exception:
                pass
        per_viewport_summary.append({
            "viewport": vp,
            "height": viewport_height_for(vp),
            "steps": steps,
            "section_candidates": section_count,
            "har": f"har/{vp}.har" if (output_dir / "har" / f"{vp}.har").exists() else None,
        })

    har_assets = collect_har_assets_from_disk(output_dir)
    return write_meta(output_dir, source_url, viewports, per_viewport_summary, har_assets)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=False, help="Required unless --replay is set")
    parser.add_argument("--viewports", required=False, default="375,768,1280,1920", help="csv of widths")
    parser.add_argument("--output", required=True)
    parser.add_argument("--wait-strategy", default="networkidle")
    parser.add_argument("--scroll-step", type=int, default=900, help="(legacy; ignored — scroll is now section-driven)")
    parser.add_argument("--skip-third-party", action="store_true")
    parser.add_argument("--replay", action="store_true", help="Skip browser capture; only re-run post-process")
    parser.add_argument("--skip-alt-height", action="store_true", help="Skip the vh-detection alt-height pass")
    parser.add_argument("--skip-section-shots", action="store_true", help="Skip the per-section cropped screenshot pass")
    args = parser.parse_args()

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.replay:
        meta_path = replay(output_dir, args.url)
        print(json.dumps({"status": "ok", "mode": "replay", "meta": str(meta_path)}))
        return

    if not args.url:
        raise SystemExit("--url is required (unless --replay)")

    script_dir = Path(__file__).resolve().parent
    init_sources = load_init_hooks(script_dir / "init-hooks")

    viewports = [int(v.strip()) for v in args.viewports.split(",") if v.strip()]

    all_assets: dict[str, dict] = {}
    per_viewport_summary: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])

        # Stage 0
        for vp in viewports:
            summary = capture_viewport(browser, vp, args.url, args.wait_strategy, init_sources, output_dir, args.skip_third_party)
            for url, a in summary.pop("assets", {}).items():
                if url not in all_assets:
                    all_assets[url] = a
            per_viewport_summary.append(summary)

        # Stage 1
        if not args.skip_alt_height and CANONICAL_WIDTH in viewports:
            try:
                alt_summary = capture_alt_height(browser, args.url, args.wait_strategy, init_sources, output_dir, args.skip_third_party)
                per_viewport_summary.append({"alt_pass": True, **alt_summary})
            except Exception as e:
                print(json.dumps({"warning": f"alt-height capture failed: {e}"}), file=sys.stderr)

        # Stage 2
        if not args.skip_section_shots:
            try:
                shots = capture_section_screenshots(browser, args.url, args.wait_strategy, init_sources, output_dir, args.skip_third_party, viewports)
                per_viewport_summary.append({"section_shots_total": shots})
            except Exception as e:
                print(json.dumps({"warning": f"section-shots pass failed: {e}"}), file=sys.stderr)

        browser.close()

    # Stage 3
    meta_path = write_meta(output_dir, args.url, viewports, per_viewport_summary, all_assets)
    print(json.dumps({"status": "ok", "mode": "capture", "meta": str(meta_path)}))


if __name__ == "__main__":
    main()
