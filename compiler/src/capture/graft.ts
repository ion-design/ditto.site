import type { PageSnapshot, RawNode, RawChild } from "./walker.js";

/**
 * Cross-origin iframe subtree graft (Stage 2). The in-page walker cannot see into a
 * cross-origin iframe (Klaviyo/newsletter embeds), so the capture used to record an
 * empty box and the clone painted a blank frame. Playwright CAN evaluate inside
 * cross-origin frames from Node, so capture.ts runs the SAME collectPage in each
 * meaningful frame and this module merges the returned subtree into the page snapshot
 * as ordinary children of the iframe node:
 *   - bboxes shift by the iframe's content-box origin (frame-doc → page-doc coords);
 *   - id/for/#href are namespaced `f<idx>-…` so two frames (or frame + page) can't
 *     collide on DOM ids in the clone;
 *   - src/srcset/href absolutize against the FRAME document's URL (generation resolves
 *     attrs against the main page URL, which would break frame-relative paths);
 *   - the grafted <body> becomes a <div>, and the iframe node clips (overflow:hidden)
 *     exactly like a real frame viewport.
 * Downstream the iframe-with-children renders as a positioned <div> (app.ts), so the
 * embed's form paints as real, styleable DOM. Frames that can't be grafted fall back
 * to an element screenshot recorded as the iframe's background (capture.ts).
 */

/** Determinism/perf caps: at most this many grafted frames per page snapshot… */
export const MAX_GRAFT_FRAMES = 10;
/** …and a per-frame walker node budget (a fraction of the main document's 12000). */
export const FRAME_GRAFT_MAX_NODES = 2000;
/** Minimum rendered size (both axes) for a frame to carry meaningful content. */
export const MIN_FRAME_DIM = 48;

export type FramePlan = "skip" | "still" | "graft";

// Ad/analytics/consent plumbing frames render nothing a visitor values — skip entirely.
// The trailing group is email-capture / promo POPUP CREATIVE hosts: a vendor whose creative
// iframe IS a full-viewport interstitial ("Enjoy 15% off" over a dimmed backdrop). Grafting it
// pours the popup's copy into the DOM/text channel and paints the modal over the real page.
// CAUTION: these hosts serve OVERLAY creatives, distinct from the vendor's INLINE-form embed
// hosts (e.g. static-forms.klaviyo.com), which stay graftable — inline signup forms are a
// deliberately-grafted feature (see iframeGraft tests). Match creative/overlay hosts only.
const FRAME_SKIP_RE =
  /(?:doubleclick\.net|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|googleadservices\.com|adservice\.google|facebook\.com\/tr|connect\.facebook\.net|\brecaptcha\b|hcaptcha\.com|challenges\.cloudflare\.com|adsrvr\.org|amazon-adsystem\.com|creatives?\.attn\.tv|\.attentivemobile\.com|bounceexchange\.com|bouncex\.net|\.wunderkind\.co|wknd\.ai|cdn\.justuno\.com\/mkjs|privy\.com\/.*popup|widget\.privy\.com|\.recart\.com|recart\.io)/i;
// Media players are JS-built canvases/videos whose DOM graft is meaningless; an element
// screenshot (the poster frame + play chrome) is the faithful static paint.
const FRAME_STILL_RE =
  /(?:youtube(?:-nocookie)?\.com\/embed|player\.vimeo\.com|\bwistia\b|fast\.wistia|players?\.brightcove|open\.spotify\.com|w\.soundcloud\.com|google\.com\/maps\/embed)/i;

/**
 * How to materialize a frame's content, from its URL alone (deterministic).
 *
 * NOTE on blank/empty-src frames: a frame with no `src` (or `about:blank`/`javascript:`)
 * is NOT inert — many form/widget embeds (Klaviyo lightbox signup, loyalty popups) mount a
 * same-origin blank iframe and inject their rendered DOM into it via script, so the element
 * carries real, sized content with no navigable URL. Those must GRAFT (the frame document is
 * same-origin, so collectPage evaluates in it directly). The dead pixels that also use a blank
 * src (analytics sandboxes, 0×0 tracking iframes) are filtered upstream by the `cand.visible`
 * gate in capture.ts — a blank frame only reaches a graft when it actually rendered at
 * ≥ MIN_FRAME_DIM on both axes, which a tracking pixel never does.
 */
export function planForFrameUrl(url: string): FramePlan {
  const u = (url || "").trim();
  if (u.startsWith("javascript:")) return "skip";
  if (!u || u === "about:blank") return "graft"; // JS-populated same-origin frame (visibility-gated)
  if (FRAME_SKIP_RE.test(u)) return "skip";
  if (FRAME_STILL_RE.test(u)) return "still";
  return "graft";
}

export type FrameCandidate = {
  idx: number;      // stable per-page index, stamped as data-ditto-frame on the element
  url: string;      // the frame element's src (absolute)
  visible: boolean; // rendered, ≥ MIN_FRAME_DIM on both axes
  // Content-box origin in page document coordinates: the offset every frame-doc bbox
  // shifts by (the child browsing context fills the iframe's content box).
  contentX: number;
  contentY: number;
};

/**
 * Stamp every iframe with a stable `data-ditto-frame` index (DOM order; idempotent so
 * later viewports reuse the same identity) and report each frame's geometry/visibility.
 * Serialized into the page via page.evaluate — must stay self-contained.
 */
export function enumerateFramesInPage(): FrameCandidate[] {
  const frames = Array.from(document.querySelectorAll("iframe"));
  let next = 0;
  for (const f of frames) {
    const cur = f.getAttribute("data-ditto-frame");
    if (cur !== null) next = Math.max(next, parseInt(cur, 10) + 1);
  }
  const sx = window.scrollX, sy = window.scrollY;
  const out: FrameCandidate[] = [];
  for (const f of frames) {
    let idxAttr = f.getAttribute("data-ditto-frame");
    if (idxAttr === null) { idxAttr = String(next++); f.setAttribute("data-ditto-frame", idxAttr); }
    const cs = getComputedStyle(f);
    const r = f.getBoundingClientRect();
    const visible = cs.display !== "none" && cs.visibility !== "hidden" &&
      parseFloat(cs.opacity || "1") > 0 && r.width >= 48 && r.height >= 48;
    out.push({
      idx: parseInt(idxAttr, 10),
      url: (f as HTMLIFrameElement).src || "",
      visible,
      contentX: Math.round((r.x + sx + parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.paddingLeft || "0")) * 100) / 100,
      contentY: Math.round((r.y + sy + parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.paddingTop || "0")) * 100) / 100,
    });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

function isTextRaw(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

/** Does the frame's captured tree paint anything (a visible element or real text)? */
export function frameHasRenderableContent(root: RawNode | undefined): boolean {
  if (!root) return false;
  const visit = (n: RawNode): boolean => {
    for (const c of n.children) {
      if (isTextRaw(c)) { if (c.text.trim().length > 0) return true; continue; }
      if (c.visible || c.rawHTML) return true;
      if (visit(c)) return true;
    }
    return false;
  };
  return visit(root);
}

/** Find the iframe RawNode stamped with the given data-ditto-frame index. */
export function findFrameNode(root: RawNode, idx: number): RawNode | null {
  if (root.tag === "iframe" && root.attrs?.["data-ditto-frame"] === String(idx)) return root;
  for (const c of root.children) {
    if (isTextRaw(c)) continue;
    const hit = findFrameNode(c, idx);
    if (hit) return hit;
  }
  return null;
}

const ABS_URL_ATTRS = ["src", "poster", "data-lazy-src", "data-src", "data-original", "data-ll-src"];
const ABS_SRCSET_ATTRS = ["srcset", "data-lazy-srcset", "data-srcset"];

/**
 * Merge one frame snapshot into the page snapshot as children of its iframe node.
 * Returns true when the graft landed. Mutates `snapshot` (offsets, namespacing and the
 * iframe's clipping are applied to the frame subtree copy embedded in it).
 */
export function graftFrameIntoSnapshot(
  snapshot: PageSnapshot,
  frame: { idx: number; contentX: number; contentY: number },
  frameSnap: PageSnapshot,
): boolean {
  const host = findFrameNode(snapshot.root, frame.idx);
  if (!host || !frameSnap?.root) return false;
  if (!frameHasRenderableContent(frameSnap.root)) return false;

  const prefix = `f${frame.idx}-`;
  const frameUrl = frameSnap.doc?.url || "";
  const abs = (u: string): string => {
    try { return new URL(u, frameUrl).href; } catch { return u; }
  };
  const absSrcset = (v: string): string =>
    v.split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      if (bits[0] && !bits[0].startsWith("data:")) bits[0] = abs(bits[0]);
      return bits.join(" ");
    }).join(", ");
  const nsIdList = (v: string): string =>
    v.split(/\s+/).filter(Boolean).map((id) => prefix + id).join(" ");

  const visit = (n: RawNode): void => {
    n.bbox = {
      ...n.bbox,
      x: Math.round((n.bbox.x + frame.contentX) * 100) / 100,
      y: Math.round((n.bbox.y + frame.contentY) * 100) / 100,
    };
    const a = n.attrs ?? {};
    delete a["data-cid-cap"]; // capture-ids belong to the main document only
    if (a.id) a.id = prefix + a.id;
    if (a.for) a.for = prefix + a.for;
    for (const k of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant"]) {
      if (a[k]) a[k] = nsIdList(a[k]!);
    }
    if (a.href) a.href = a.href.startsWith("#") ? "#" + prefix + a.href.slice(1) : abs(a.href);
    for (const k of ABS_URL_ATTRS) if (a[k] && !a[k]!.startsWith("data:")) a[k] = abs(a[k]!);
    for (const k of ABS_SRCSET_ATTRS) if (a[k]) a[k] = absSrcset(a[k]!);
    for (const c of n.children) if (!isTextRaw(c)) visit(c);
  };

  const wrapper = frameSnap.root; // the frame's <body>
  visit(wrapper);
  wrapper.tag = "div"; // a nested <body> is not valid; the box/styles replay identically

  host.children = [wrapper];
  // A real frame viewport clips its document; the replacement <div> must too, at every
  // captured viewport (each per-viewport snapshot is grafted independently).
  host.computed = { ...host.computed, overflow: "hidden", overflowX: "hidden", overflowY: "hidden" };
  // An iframe is a REPLACED element: `display:inline` (the default) still honors its
  // width/height. The <div> that replaces it at generation is not — inline would collapse
  // the box — so translate to the behavior-equivalent inline-block.
  if ((host.computed.display || "inline") === "inline") host.computed.display = "inline-block";
  // Diagnostics only (nodeCount is logged, never gated).
  snapshot.doc.nodeCount += frameSnap.doc?.nodeCount ?? 0;
  // @keyframes referenced by grafted nodes must exist in the page snapshot's set.
  if (frameSnap.keyframes?.length) snapshot.keyframes.push(...frameSnap.keyframes);
  return true;
}
