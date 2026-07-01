#!/usr/bin/env python3
"""For every node whose width VARIES across viewports (=> would emit a width band),
classify the underlying law: hairline / parent-fill / fraction-of-parent / step.
Tells us how many bands each recovery law would eliminate."""
import json, glob, os, sys, collections
run = sys.argv[1] if len(sys.argv) > 1 else "compiler/output/sample/.clone"
caps = {}
for f in sorted(glob.glob(os.path.join(run, "source/capture/dom-*.json"))):
    caps[int(os.path.basename(f)[4:-5])] = json.load(open(f))["root"]
VPS = sorted(caps)
# flatten each viewport in pre-order, aligned by index
F = {vp: [] for vp in VPS}
PARENT = []
def flat(n, a, parent_idx, store_parent):
    idx = len(a); a.append(n)
    if store_parent: PARENT.append(parent_idx)
    for c in (n.get("children") or []):
        flat(c, a, idx, store_parent)
for vp in VPS:
    flat(caps[vp], F[vp], -1, vp == VPS[0])
N = len(F[VPS[0]])
def pf(v):
    try: return float(str(v).replace("px",""))
    except: return 0.0
def cs(i, vp): return F[vp][i].get("computed") or {}
def bb(i, vp): return F[vp][i].get("bbox") or {}
def vis(i, vp):
    if not F[vp][i].get("visible"): return False
    if (cs(i,vp).get("display")=="none"): return False
    return True
def width(i, vp): return bb(i, vp).get("width", 0)
def parent_content_w(i, vp):
    p = PARENT[i]
    if p < 0: return bb(i,vp).get("width",0)
    pc = cs(p, vp)
    return bb(p,vp).get("width",0) - pf(pc.get("paddingLeft")) - pf(pc.get("paddingRight")) - pf(pc.get("borderLeftWidth")) - pf(pc.get("borderRightWidth"))

FRACTIONS = {1/2:"1/2",1/3:"1/3",2/3:"2/3",1/4:"1/4",3/4:"3/4",1/5:"1/5",2/5:"2/5",3/5:"3/5",4/5:"4/5",1/6:"1/6",5/6:"5/6"}
cat = collections.Counter()
band_cat = collections.Counter()
examples = collections.defaultdict(list)
for i in range(N):
    ws = {vp: width(i,vp) for vp in VPS if vis(i,vp)}
    if len(ws) < 2: continue
    wv = list(ws.values())
    spread = max(wv) - min(wv)
    if spread <= 1.0: continue            # constant => no band
    # how many band variants would this node emit? (# distinct rounded widths across the 4 band vps) - 1
    distinct = len(set(round(w) for w in wv))
    bands = distinct - 1
    if bands < 1: continue
    # --- classify ---
    if max(wv) < 2.0:
        c = "hairline(<2px)"
    else:
        ratios = []
        ok_parent = True
        for vp, w in ws.items():
            pcw = parent_content_w(i, vp)
            if pcw <= 0: ok_parent = False; break
            ratios.append(w / pcw)
        if not ok_parent:
            c = "no-parent"
        elif max(ratios) - min(ratios) < 0.03 and abs(sum(ratios)/len(ratios) - 1.0) < 0.03:
            c = "parent-fill(100%)"
        else:
            avg = sum(ratios)/len(ratios)
            # nearest simple fraction
            best = min(FRACTIONS, key=lambda f: abs(f-avg))
            if max(ratios)-min(ratios) < 0.03 and abs(best-avg) < 0.015:
                c = f"fraction~{FRACTIONS[best]}"
            elif max(ratios)-min(ratios) < 0.04:
                c = "const-%(other)"
            else:
                c = "step/other"
    cat[c] += 1
    band_cat[c] += bands
    if len(examples[c]) < 4:
        examples[c].append((round(min(wv),1), round(max(wv),1), [round(width(i,vp)) for vp in VPS]))

print(f"nodes with width-bands: {sum(cat.values())}   total band-variants: {sum(band_cat.values())}")
print(f"{'category':22} {'nodes':>6} {'bands':>6}")
for c,_ in band_cat.most_common():
    print(f"{c:22} {cat[c]:>6} {band_cat[c]:>6}   eg {examples[c][:3]}")
