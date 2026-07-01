#!/usr/bin/env python3
"""Build before/after (source vs clone) composites for the multi-page `sites` benchmark.

For each site: a stacked PNG of a few key routes (entry + listings/representatives),
each a labeled SOURCE|CLONE row at the desktop (1280px) viewport, titled with the
site's per-route pass summary. Mirrors make_compare.py but reads the site run layout
(runs/site-<host>/<ts>/routes/<key>/{source,rendered}/screenshots/<vp>.png).
"""
import json, os, sys, glob, re
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RUNS = os.path.join(ROOT, "runs")
OUT = os.path.join(RUNS, "compare-sites")
os.makedirs(OUT, exist_ok=True)
MAX_ROUTES = int(os.environ.get("MAX_ROUTES", "4"))

def font(sz):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

F_TITLE, F_LABEL = font(30), font(20)
PAD, HEADER, TITLE, GAP = 16, 42, 60, 10
BG, INK, RULE = (250, 250, 250), (20, 20, 20), (210, 210, 210)

def host_of(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    host = re.sub(r"^www\.", "", u.hostname or "")
    path = re.sub(r"^-|-$", "", re.sub(r"[^a-zA-Z0-9]+", "-", u.path.rstrip("/")))
    sid = host + (("-" + path) if path else "")
    return "site-" + re.sub(r"[^a-zA-Z0-9.-]", "-", sid)[:80]

def sanitize_seg(s):
    out = re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9._-]", "-", s)).strip("-")
    if out == "" or re.match(r"^[_(@.]", out):
        out = "r-" + re.sub(r"^[_(@.]+", "", out)
    return out or "r"

def route_key(path):
    if path == "/":
        return "home"
    segs = [sanitize_seg(s) for s in path.split("/") if s]
    return "__".join(segs) or "home"

def latest_run(host):
    for d in sorted(glob.glob(os.path.join(RUNS, host, "*")), reverse=True):
        if os.path.exists(os.path.join(d, "site-manifest.json")):
            return d
    return None

def load(path, scale, max_h):
    if not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGB")
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    if im.height > max_h:
        im = im.crop((0, 0, im.width, max_h))
    return im

def row(src_path, clone_path, scale, max_h, label):
    s, c = load(src_path, scale, max_h), load(clone_path, scale, max_h)
    if s is None and c is None:
        return None
    sw = s.width if s else (c.width if c else 0)
    cw = c.width if c else sw
    body_h = max(s.height if s else 0, c.height if c else 0)
    img = Image.new("RGB", (sw + GAP + cw, HEADER + body_h), BG)
    d = ImageDraw.Draw(img)
    d.text((4, 8), label, font=F_LABEL, fill=INK)
    d.text((4, HEADER - 6), "SOURCE", font=F_LABEL, fill=(90, 90, 90))
    d.text((sw + GAP + 4, HEADER - 6), "CLONE", font=F_LABEL, fill=(90, 90, 90))
    if s: img.paste(s, (0, HEADER))
    if c: img.paste(c, (sw + GAP, HEADER))
    d.line([(sw + GAP // 2, HEADER), (sw + GAP // 2, img.height)], fill=RULE, width=2)
    return img

def stack(title, rows):
    rows = [r for r in rows if r is not None]
    if not rows:
        return None
    W = max(r.width for r in rows) + PAD * 2
    H = TITLE + sum(r.height for r in rows) + PAD * (len(rows) + 1)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((PAD, 16), title, font=F_TITLE, fill=INK)
    d.line([(0, TITLE - 4), (W, TITLE - 4)], fill=RULE, width=2)
    y = TITLE + PAD
    for r in rows:
        img.paste(r, (PAD, y))
        y += r.height + PAD
    return img

def main():
    sites = json.load(open(os.path.join(ROOT, "compiler", "benchmarks", "sites.json")))
    made = []
    for site in sites:
        host = host_of(site["url"])
        run = latest_run(host)
        if not run:
            print(f"SKIP {site['id']}: no run"); continue
        man = json.load(open(os.path.join(run, "site-manifest.json")))
        report = None
        rp = os.path.join(run, "validation", "site-report.json")
        if os.path.exists(rp):
            report = json.load(open(rp))
        summ = ""
        if report:
            summ = f"  —  {report['routesGates0to6']}/{report['routesTotal']} routes pass gates 0–6"
        routes = man.get("routes", [])[:MAX_ROUTES]
        rows = []
        for r in routes:
            key = route_key(r["routePath"])
            ss = os.path.join(run, "routes", key, "source", "screenshots", "1280.png")
            rs = os.path.join(run, "routes", key, "rendered", "screenshots", "1280.png")
            rows.append(row(ss, rs, 0.5, 1400, f"{r.get('role','page')}  ·  {r['href']}"))
        img = stack(f"{site['id']}  ({host}){summ}", rows)
        if img is None:
            print(f"SKIP {site['id']}: no screenshots"); continue
        out = os.path.join(OUT, f"{site['id']}.png")
        img.save(out, optimize=True)
        made.append(out)
        print(f"OK {out}  ({img.width}x{img.height})")
    print(f"\n{len(made)} composites -> {OUT}")

if __name__ == "__main__":
    main()
