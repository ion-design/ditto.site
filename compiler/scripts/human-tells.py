#!/usr/bin/env python3
"""Human-tell diagnostic: count patterns a human would (almost) never hand-write.

Separate from codeAudit.ts — this is the "would a human write this?" lens, focused on
specific robotic constructs, scanned over the .tsx/.css of each tree. Prints a column per tree.
Usage: human-tells.py <label=dir> ...
"""
import re, sys, os

def read_tree(d):
    tsx, css = [], []
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x not in ("node_modules", ".next", "out") and not x.startswith(".")]
        for f in files:
            p = os.path.join(root, f)
            try:
                s = open(p, encoding="utf8").read()
            except Exception:
                continue
            if f.endswith((".tsx", ".jsx", ".ts")):
                tsx.append(s)
            elif f.endswith(".css"):
                css.append(s)
    return "\n".join(tsx), "\n".join(css)

def count(pat, s):
    return len(re.findall(pat, s))

TELLS = {
    # noise / redundancy — almost never hand-written
    "noop relative inset (top-0 right-0 bottom-0 left-0)": (lambda tsx, css: count(r'\btop-0 right-0 bottom-0 left-0\b', tsx), True),
    "redundant gap+gap-x+gap-y (same n)": (lambda tsx, css: len([m for m in re.finditer(r'\bgap-(\d+(?:\.\d+)?) gap-y-(\d+(?:\.\d+)?) gap-x-(\d+(?:\.\d+)?)', tsx) if m.group(1)==m.group(2)==m.group(3)]), True),
    "4-side longhand pad (pt-x pr-y pb-x pl-y)": (lambda tsx, css: count(r'\bpt-\S+ pr-\S+ pb-\S+ pl-\S+', tsx), True),
    "per-side border arbitrary [border-*]": (lambda tsx, css: count(r'\[border-(?:top|right|bottom|left)-(?:style|color|width):', tsx+css), True),
    "baked runtime id (radix/_R_/:r)": (lambda tsx, css: count(r'id=\"(?:radix-|[^\"]*_R_|:r)', tsx), True),
    "[text-align:inherit] override": (lambda tsx, css: count(r'\[text-align:inherit\]', tsx), True),
    "data-cid shipped (jsx)": (lambda tsx, css: count(r'data-cid', tsx), True),
    "data-cid selectors in ditto.css": (lambda tsx, css: count(r'data-cid', css), True),
    # font-size arbitrary that maps to a named tailwind size (should be text-xs..text-9xl)
    "font-size arbitrary mappable to named": (lambda tsx, css: len([m for m in re.finditer(r'text-\[(\d+(?:\.\d+)?)(px|rem)\]', tsx) if round((float(m.group(1))*(16 if m.group(2)=='rem' else 1)))/16 in NAMED_REM]), True),
    # decimal arbitrary in JSX classes (sub-pixel frozen measurement)
    "decimal arbitrary [N.NNpx/rem] (jsx)": (lambda tsx, css: len([m for m in re.finditer(r'\[(-?\d+\.?\d*)(px|rem)\]', tsx) if abs((v:=float(m.group(1))*(16 if m.group(2)=='rem' else 1))-round(v))>0.02]), True),
    # decimal px in ditto.css (uncounted by codeAudit)
    "decimal px in ditto.css (Npx)": (lambda tsx, css: len([m for m in re.finditer(r'(-?\d+\.\d+)px', css) if abs((v:=float(m.group(1)))-round(v))>0.02]), True),
    "pseudo-element rules in ditto.css": (lambda tsx, css: count(r'::(?:before|after)\b', css), True),
}
# named tailwind text sizes in rem
NAMED_REM = {0.75, 0.875, 1.0, 1.125, 1.25, 1.5, 1.875, 2.25, 3.0, 3.75, 4.5, 6.0, 8.0}

def main():
    trees = []
    for a in sys.argv[1:]:
        label, d = a.split("=", 1)
        trees.append((label, read_tree(d)))
    w0 = max(len(k) for k in TELLS)
    cw = max(11, *(len(l) for l, _ in trees))
    print("\n" + "metric".ljust(w0) + "  " + "".join(l.ljust(cw) for l, _ in trees))
    print("-" * (w0 + 2 + cw * len(trees)))
    for k, (fn, _) in TELLS.items():
        cells = "".join(str(fn(tsx, css)).ljust(cw) for _, (tsx, css) in trees)
        print(k.ljust(w0) + "  " + cells)
    print()

main()
