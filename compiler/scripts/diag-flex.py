#!/usr/bin/env python3
"""Replicate the (updated) reconstructFlexRow and report success + bail reasons + band impact."""
import json, glob, os, sys, collections
run = sys.argv[1] if len(sys.argv) > 1 else "compiler/output-dense/sample/.clone"
caps = {}
for f in sorted(glob.glob(os.path.join(run, "source/capture/dom-*.json"))):
    caps[int(os.path.basename(f)[4:-5])] = json.load(open(f))["root"]
VPS = sorted(caps); BAND_VPS = [v for v in (375, 768, 1280, 1920) if v in VPS]
acc = []
def walkidx(n):
    n["_i"] = len(acc); acc.append(n); n["_kids"] = []
    for c in (n.get("children") or []):
        n["_kids"].append(len(acc)); walkidx(c)
walkidx(caps[VPS[0]])
N = len(acc)
# per-vp flat lists aligned by index
F = {vp: [] for vp in VPS}
def flat(n, a):
    a.append(n)
    for c in (n.get("children") or []): flat(c, a)
for vp in VPS: flat(caps[vp], F[vp])
def pf(v):
    try: return float(str(v).replace("px", ""))
    except: return 0.0
def CS(i, vp): return F[vp][i].get("computed") or {}
def BB(i, vp): return F[vp][i].get("bbox") or {}
def VIS(i, vp): return F[vp][i].get("visible")
reasons = collections.Counter(); succ = 0; succ_items = 0; bands_removed = 0
for i in range(N):
    c0 = CS(i, VPS[0]); disp = c0.get("display", "")
    if "flex" not in disp: continue
    if c0.get("flexDirection", "row") not in ("row", "row-reverse"): reasons["not_row"] += 1; continue
    if (c0.get("flexWrap") or "nowrap") != "nowrap": reasons["wrap"] += 1; continue
    info = []; bail = None
    for k in acc[i]["_kids"]:
        if not acc[k].get("tag"): continue
        ck = CS(k, VPS[0]); pos = ck.get("position", "static")
        if pos in ("absolute", "fixed"): continue
        if (ck.get("float") or "none") != "none": continue
        if ck.get("marginLeft") == "auto" or ck.get("marginRight") == "auto": bail = "auto_margin"; break
        if (ck.get("boxSizing") or "border-box") == "content-box": bail = "content_box"; break
        if pf(ck.get("flexGrow")) > 0: bail = "grow"; break
        basis = ck.get("flexBasis") or "auto"
        if basis != "auto" and not basis.endswith("px"): bail = "basis_pct"; break
        info.append((k, pf(ck.get("flexShrink")), pf(basis) if basis.endswith("px") else None,
                     pf(ck.get("minWidth")) if (ck.get("minWidth") or "").endswith("px") else 0,
                     pf(ck.get("maxWidth")) if (ck.get("maxWidth") or "").endswith("px") else float("inf")))
    if bail: reasons[bail] += 1; continue
    if not info: continue
    used = {}; margin = {}; cw = {}; gap = {}
    for vp in VPS:
        pcs = CS(i, vp); pb = BB(i, vp)
        cw[vp] = pb.get("width", 0) - pf(pcs.get("paddingLeft")) - pf(pcs.get("paddingRight"))
        gap[vp] = pf(pcs.get("columnGap") if pcs.get("columnGap") not in (None, "normal") else pcs.get("gap"))
        u = []; m = []
        for (k, sh, bp, mn, mx) in info:
            ck = CS(k, vp); hidden = (not VIS(k, vp)) or ck.get("display") == "none"
            u.append(None if hidden else BB(k, vp).get("width", 0)); m.append(0 if hidden else pf(ck.get("marginLeft")) + pf(ck.get("marginRight")))
        used[vp] = u; margin[vp] = m
    def slack(vp):
        vis = [j for j in range(len(info)) if used[vp][j] is not None]
        return cw[vp] - sum(used[vp][j] for j in vis) - (gap[vp] * max(0, len(vis) - 1) + sum(margin[vp][j] for j in vis))
    bases = []; ok = True
    for j, (k, sh, bp, mn, mx) in enumerate(info):
        if bp is not None: bases.append(bp); continue
        base = None
        for v in range(len(VPS) - 1, -1, -1):
            vp = VPS[v]
            if used[vp][j] is None: continue
            if slack(vp) >= -0.5: base = used[vp][j]; break
        if base is None: ok = False; break
        bases.append(base)
    if not ok: reasons["no_base"] += 1; continue
    bad = False
    for vp in VPS:
        vis = [j for j in range(len(info)) if used[vp][j] is not None]
        if not vis: continue
        hyp = [min(max(bases[j], info[j][3]), info[j][4]) for j in vis]
        gaps = gap[vp] * max(0, len(vis) - 1) + sum(margin[vp][j] for j in vis)
        free = cw[vp] - sum(hyp) - gaps
        sim = list(hyp)
        if free < -0.5:
            ts = sum(info[vis[k]][1] * hyp[k] for k in range(len(vis)))
            if ts > 0:
                for k in range(len(vis)): sim[k] = max(hyp[k] - abs(free) * (info[vis[k]][1] * hyp[k]) / ts, info[vis[k]][3])
        for k in range(len(vis)):
            if abs(sim[k] - used[vp][vis[k]]) > 1: bad = True
    if bad: reasons["sim_mismatch"] += 1; continue
    varies = [j for j in range(len(info)) if len([used[vp][j] for vp in VPS if used[vp][j] is not None]) >= 2 and max(x for vp in VPS if (x:=used[vp][j]) is not None) - min(x for vp in VPS if (x:=used[vp][j]) is not None) > 8]
    if not varies: reasons["no_variation"] += 1; continue
    succ += 1; succ_items += len(info)
    # estimate band variants removed: for each varying item, count distinct band-vp widths != base-vp
    for j in varies:
        bandw = set(round(used[vp][j]) for vp in BAND_VPS if used[vp][j] is not None)
        bands_removed += max(0, len(bandw) - 1)
print(f"SUCCESS lines: {succ}  items: {succ_items}  est. width-band variants removed: ~{bands_removed}")
for k, v in reasons.most_common(): print(f"  bail {k:16} {v}")
