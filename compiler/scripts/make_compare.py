#!/usr/bin/env python3
"""Build before/after (source vs clone) screenshot composites for a tier.

For each site: a single PNG with a desktop row (1280px) and a mobile row (375px),
each showing SOURCE on the left and CLONE on the right, with labels.
"""
import json, os, sys, glob, re
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RUNS = os.path.join(ROOT, "runs")
TIER = sys.argv[1] if len(sys.argv) > 1 else "easy"
OUT = os.path.join(RUNS, f"compare-{TIER}")
os.makedirs(OUT, exist_ok=True)

def font(sz):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

F_TITLE = font(30)
F_LABEL = font(22)

def host_of(url):
    # Mirror siteIdFromUrl() in cli.ts: host (minus www) + slugified path.
    from urllib.parse import urlparse
    u = urlparse(url)
    host = re.sub(r"^www\.", "", u.hostname or "")
    path = re.sub(r"^-|-$", "", re.sub(r"[^a-zA-Z0-9]+", "-", u.path.rstrip("/")))
    sid = host + (("-" + path) if path else "")
    return re.sub(r"[^a-zA-Z0-9.-]", "-", sid)[:80]

def latest_run(host):
    dirs = sorted(glob.glob(os.path.join(RUNS, host, "*")), reverse=True)
    for d in dirs:
        if (os.path.exists(os.path.join(d, "source", "screenshots")) and
                os.path.exists(os.path.join(d, "rendered", "screenshots"))):
            return d
    return None

def load(path, scale, max_h):
    if not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGB")
    w = int(im.width * scale)
    h = int(im.height * scale)
    im = im.resize((w, h), Image.LANCZOS)
    if im.height > max_h:                       # cap very tall pages
        im = im.crop((0, 0, im.width, max_h))
    return im

PAD = 16
HEADER = 46          # per-row label strip
TITLE = 56           # site title strip
GAP = 10             # gap between source and clone
BG = (250, 250, 250)
INK = (20, 20, 20)
RULE = (210, 210, 210)

def row(src_path, clone_path, scale, max_h, label):
    """One labeled row: [SOURCE | CLONE] side by side, top-aligned."""
    s = load(src_path, scale, max_h)
    c = load(clone_path, scale, max_h)
    if s is None and c is None:
        return None
    sw = s.width if s else (c.width if c else 0)
    cw = c.width if c else sw
    sh = s.height if s else 0
    ch = c.height if c else 0
    body_h = max(sh, ch)
    W = sw + GAP + cw
    H = HEADER + body_h
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((4, 10), label, font=F_LABEL, fill=INK)
    d.text((4, HEADER - 4), "SOURCE", font=F_LABEL, fill=(90, 90, 90))
    d.text((sw + GAP + 4, HEADER - 4), "CLONE", font=F_LABEL, fill=(90, 90, 90))
    if s: img.paste(s, (0, HEADER))
    if c: img.paste(c, (sw + GAP, HEADER))
    # divider line between the pair
    d.line([(sw + GAP // 2, HEADER), (sw + GAP // 2, H)], fill=RULE, width=2)
    return img

def stack(title, rows):
    rows = [r for r in rows if r is not None]
    if not rows:
        return None
    W = max(r.width for r in rows) + PAD * 2
    H = TITLE + sum(r.height for r in rows) + PAD * (len(rows) + 1)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((PAD, 14), title, font=F_TITLE, fill=INK)
    d.line([(0, TITLE - 4), (W, TITLE - 4)], fill=RULE, width=2)
    y = TITLE + PAD
    for r in rows:
        img.paste(r, (PAD, y))
        y += r.height + PAD
    return img

def main():
    sites = json.load(open(os.path.join(ROOT, "compiler", "benchmarks", f"{TIER}.json")))
    made = []
    for site in sites:
        host = host_of(site["url"])
        run = latest_run(host)
        if not run:
            print(f"SKIP {site['id']} {host}: no run with screenshots")
            continue
        ss = os.path.join(run, "source", "screenshots")
        rs = os.path.join(run, "rendered", "screenshots")
        title = f"{site['id']}  —  {host}"
        desktop = row(os.path.join(ss, "1280.png"), os.path.join(rs, "1280.png"),
                      0.5, 1600, "Desktop  ·  1280px viewport  (shown at 50%)")
        mobile = row(os.path.join(ss, "375.png"), os.path.join(rs, "375.png"),
                     1.0, 1800, "Mobile  ·  375px viewport  (100%)")
        img = stack(title, [desktop, mobile])
        if img is None:
            print(f"SKIP {site['id']}: no images")
            continue
        out = os.path.join(OUT, f"{site['id']}-{host}.png")
        img.save(out, optimize=True)
        made.append(out)
        print(f"OK {out}  ({img.width}x{img.height})")
    print(f"\n{len(made)} composites -> {OUT}")

if __name__ == "__main__":
    main()
