#!/usr/bin/env python3
"""Classify width-varying nodes in a DENSE capture by their sizing law, using the full
sample curve. Run after a dense clone: python3 scripts/analyze-dense.py <run/.clone> """
import json, sys, statistics, glob, os
run = sys.argv[1] if len(sys.argv) > 1 else "output-dense/sample/.clone"
caps = {}
for f in sorted(glob.glob(os.path.join(run, "source/capture/dom-*.json"))):
    vp = int(os.path.basename(f)[4:-5])
    caps[vp] = json.load(open(f))["root"]
VPS = sorted(caps)
print("sample widths:", VPS)

def flat(n, a):
    if isinstance(n, dict):
        a.append(n)
        for c in (n.get("children") or []): flat(c, a)
F = {vp: [] for vp in VPS}
for vp in VPS: flat(caps[vp], F[vp])
def wp(n, p, m):
    m[id(n)] = p
    for c in (n.get("children") or []): wp(c, n, m)
PM = {vp: {} for vp in VPS}
for vp in VPS: wp(caps[vp], None, PM[vp])
def pf(v):
    try: return float(str(v).replace("px", ""))
    except: return 0.0

n = min(len(F[vp]) for vp in VPS)
cats = {"fills_container": 0, "prop_container": 0, "prop_viewport": 0, "clamped_maxw": 0,
        "shrink_recoverable": 0, "real_breakpoint": 0, "fixed": 0, "unknown": 0}
for i in range(n):
    nd = {vp: F[vp][i] for vp in VPS}
    if not all(nd[vp].get("visible") for vp in VPS): continue
    w = {vp: (nd[vp].get("bbox") or {}).get("width", 0) for vp in VPS}
    if max(w.values()) - min(w.values()) <= 2: continue  # constant → no band
    # container content width per vp
    cw = {}
    for vp in VPS:
        p = PM[vp].get(id(nd[vp])); pb = (p or {}).get("bbox"); pcs = (p or {}).get("computed") or {}
        base = pb["width"] if pb else vp
        cw[vp] = base - pf(pcs.get("paddingLeft")) - pf(pcs.get("paddingRight"))
    rc = [w[vp] / cw[vp] for vp in VPS if cw[vp] > 0]
    rv = [w[vp] / vp for vp in VPS]
    def cv(xs):
        m = statistics.mean(xs); return statistics.pstdev(xs) / m if m else 9
    wl = [w[vp] for vp in VPS]
    if rc and cv(rc) < 0.02 and abs(statistics.mean(rc) - 1) < 0.02: cats["fills_container"] += 1
    elif rc and cv(rc) < 0.03: cats["prop_container"] += 1
    elif cv(rv) < 0.03: cats["prop_viewport"] += 1
    elif wl[-1] == wl[-2] and wl[0] < wl[-1]:  # plateau at the widest → clamp or recoverable shrink
        # constant above a knee, smaller below
        cats["clamped_maxw"] += 1
    elif wl[-1] < wl[-2]:  # still shrinking even at the widest → natural beyond range
        cats["shrink_recoverable"] += 1
    else:
        # piecewise? count distinct plateaus
        cats["unknown"] += 1
print("\nwidth-varying nodes by inferred sizing law (dense):")
for k, v in cats.items(): print(f"  {k:20} {v}")
print(f"  TOTAL varying: {sum(cats.values())}")
