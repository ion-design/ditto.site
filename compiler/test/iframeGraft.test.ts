import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageSnapshot, RawNode, RawChild } from "../src/capture/walker.js";
import {
  planForFrameUrl, graftFrameIntoSnapshot, frameHasRenderableContent, findFrameNode,
} from "../src/capture/graft.js";
import { captureSite } from "../src/capture/capture.js";
import { buildIR, isTextChild, type IRNode } from "../src/normalize/ir.js";
import { resolveTag, propsList } from "../src/generate/app.js";
import { readJSON } from "../src/util/fsx.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// ---- Synthetic snapshot helpers (unit tests for the merge/offset logic) ----

function isText(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

function raw(tag: string, attrs: Record<string, string> = {}, children: RawChild[] = [], over: Partial<RawNode> = {}): RawNode {
  return {
    tag, attrs,
    computed: { display: "block", position: "static" },
    bbox: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    children,
    ...over,
  };
}

function pageSnap(root: RawNode, url = "https://host.test/page"): PageSnapshot {
  return {
    doc: {
      url, title: "t",
      head: { description: "", canonical: "", ogTitle: "", ogDescription: "", ogImage: "", ogType: "", ogSiteName: "", twitterCard: "", themeColor: "" },
      lang: "en", charset: "UTF-8", viewportWidth: 800, viewportHeight: 600,
      scrollWidth: 800, scrollHeight: 600, htmlBg: "", bodyBg: "", bodyColor: "", bodyFont: "",
      metaViewport: "", nodeCount: 3, truncated: false,
    },
    root, cssVars: {}, fontFaces: [], cssUrls: [], domAssets: [], keyframes: [],
  };
}

describe("planForFrameUrl", () => {
  it("skips javascript: frames and ad/analytics/captcha domains", () => {
    assert.equal(planForFrameUrl("javascript:void(0)"), "skip");
    assert.equal(planForFrameUrl("https://googleads.g.doubleclick.net/pagead/ads"), "skip");
    assert.equal(planForFrameUrl("https://www.googletagmanager.com/ns.html?id=GTM-X"), "skip");
    assert.equal(planForFrameUrl("https://www.google.com/recaptcha/api2/anchor"), "skip");
  });

  it("grafts blank/empty-src frames (JS-populated same-origin embeds), visibility-gated upstream", () => {
    // Klaviyo lightbox signup, loyalty popups etc. render into a blank same-origin iframe via
    // script — no navigable URL, but real content. Invisible tracking pixels sharing a blank
    // src are dropped by the cand.visible gate in capture.ts, not here.
    assert.equal(planForFrameUrl(""), "graft");
    assert.equal(planForFrameUrl("about:blank"), "graft");
  });

  it("screenshots media-player embeds instead of grafting their JS-built DOM", () => {
    assert.equal(planForFrameUrl("https://www.youtube.com/embed/abc123"), "still");
    assert.equal(planForFrameUrl("https://player.vimeo.com/video/1"), "still");
    assert.equal(planForFrameUrl("https://www.google.com/maps/embed?pb=x"), "still");
  });

  it("grafts everything else (form/newsletter embeds)", () => {
    assert.equal(planForFrameUrl("https://static-forms.klaviyo.com/forms/abc"), "graft");
    assert.equal(planForFrameUrl("http://127.0.0.1:4001/iframe-embed.html"), "graft");
  });

  it("SKIPS full-viewport promo POPUP CREATIVE hosts (Attentive/Recart/Wunderkind overlays)", () => {
    // These vendor hosts serve a full-viewport interstitial creative — grafting pours the
    // popup's copy into the DOM/text channel and paints the modal over the real page.
    assert.equal(planForFrameUrl("https://creatives.attn.tv/creative/12345"), "skip");
    assert.equal(planForFrameUrl("https://creative.attn.tv/loader/x"), "skip");
    assert.equal(planForFrameUrl("https://app.recart.com/popup/abc"), "skip");
    assert.equal(planForFrameUrl("https://tag.wunderkind.co/creative"), "skip");
    assert.equal(planForFrameUrl("https://api.bounceexchange.com/creative"), "skip");
  });

  it("STILL grafts INLINE embed hosts even for the same vendors (inline forms are a feature)", () => {
    // Caution guard: a deliberately-grafted inline signup form must never be caught by the
    // popup-creative skip list. Inline-form hosts differ from overlay-creative hosts.
    assert.equal(planForFrameUrl("https://static-forms.klaviyo.com/forms/abc"), "graft");
    assert.equal(planForFrameUrl("https://manage.kmail-lists.com/subscriptions/subscribe"), "graft");
  });
});

describe("graftFrameIntoSnapshot", () => {
  const mkHost = (): PageSnapshot =>
    pageSnap(raw("body", {}, [
      raw("iframe", { "data-ditto-frame": "0", src: "https://frame.test/embed" }, [], {
        bbox: { x: 40, y: 30, width: 320, height: 160 },
      }),
    ]));

  const mkFrame = (): PageSnapshot => {
    const input = raw("input", { id: "email", placeholder: "Enter your email" }, [], {
      bbox: { x: 12, y: 34, width: 200, height: 30 },
    });
    const label = raw("label", { for: "email" }, [{ text: "Email" }]);
    const anchor = raw("a", { href: "#terms" }, [{ text: "Terms" }]);
    const img = raw("img", { src: "/pixel.png", srcset: "/pixel.png 1x, /pixel@2x.png 2x" });
    const form = raw("form", { id: "signup" }, [label, input, anchor, img], {
      bbox: { x: 0, y: 0, width: 320, height: 160 },
    });
    return pageSnap(raw("body", {}, [form]), "https://frame.test/embed");
  };

  it("grafts the frame body as a <div> child of the iframe with offset bboxes", () => {
    const host = mkHost();
    const ok = graftFrameIntoSnapshot(host, { idx: 0, contentX: 40, contentY: 30 }, mkFrame());
    assert.equal(ok, true);
    const iframe = findFrameNode(host.root, 0)!;
    assert.equal(iframe.children.length, 1);
    const wrapper = iframe.children[0] as RawNode;
    assert.equal(wrapper.tag, "div", "the grafted <body> is retagged to <div>");
    const form = wrapper.children[0] as RawNode;
    assert.deepEqual([form.bbox.x, form.bbox.y], [40, 30], "frame-doc coords shift by the content-box origin");
    const input = form.children.find((c) => !isText(c) && (c as RawNode).tag === "input") as RawNode;
    assert.deepEqual([input.bbox.x, input.bbox.y], [52, 64]);
  });

  it("namespaces ids/for/#href so two frames cannot collide, and absolutizes frame-relative URLs", () => {
    const host = mkHost();
    graftFrameIntoSnapshot(host, { idx: 0, contentX: 40, contentY: 30 }, mkFrame());
    const iframe = findFrameNode(host.root, 0)!;
    const form = (iframe.children[0] as RawNode).children[0] as RawNode;
    assert.equal(form.attrs.id, "f0-signup");
    const byTag = (t: string): RawNode => form.children.find((c) => !isText(c) && (c as RawNode).tag === t) as RawNode;
    assert.equal(byTag("input").attrs.id, "f0-email");
    assert.equal(byTag("label").attrs.for, "f0-email");
    assert.equal(byTag("a").attrs.href, "#f0-terms");
    assert.equal(byTag("img").attrs.src, "https://frame.test/pixel.png");
    assert.equal(byTag("img").attrs.srcset, "https://frame.test/pixel.png 1x, https://frame.test/pixel@2x.png 2x");
  });

  it("makes the iframe clip like a real frame viewport (overflow:hidden)", () => {
    const host = mkHost();
    graftFrameIntoSnapshot(host, { idx: 0, contentX: 40, contentY: 30 }, mkFrame());
    const iframe = findFrameNode(host.root, 0)!;
    assert.equal(iframe.computed.overflow, "hidden");
    assert.equal(iframe.computed.overflowY, "hidden");
  });

  it("refuses to graft an empty/invisible frame (screenshot fallback territory)", () => {
    const host = mkHost();
    const empty = pageSnap(raw("body", {}, [raw("div", {}, [], { visible: false, bbox: { x: 0, y: 0, width: 0, height: 0 } })]), "https://frame.test/embed");
    assert.equal(frameHasRenderableContent(empty.root), false);
    assert.equal(graftFrameIntoSnapshot(host, { idx: 0, contentX: 40, contentY: 30 }, empty), false);
    assert.equal(findFrameNode(host.root, 0)!.children.length, 0);
  });

  it("merges the frame's @keyframes into the page snapshot", () => {
    const host = mkHost();
    const frame = mkFrame();
    frame.keyframes = ["@keyframes spin { to { transform: rotate(360deg); } }"];
    graftFrameIntoSnapshot(host, { idx: 0, contentX: 40, contentY: 30 }, frame);
    assert.ok(host.keyframes.includes("@keyframes spin { to { transform: rotate(360deg); } }"));
  });
});

// ---- Cross-origin integration: capture → snapshot graft → IR → generated tag ----

describe("cross-origin iframe capture (integration)", () => {
  let hostServer: Server;
  let frameServer: Server;
  let hostUrl = "";
  let frameOrigin = "";
  let outDir = "";

  // A 1x1 transparent PNG so the frame's <img src="/pixel.png"> resolves and downloads.
  const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  before(async () => {
    const frameHtml = readFileSync(join(FIXTURES, "iframe-embed.html"), "utf8");
    frameServer = createServer((req, res) => {
      if (req.url?.startsWith("/pixel.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PIXEL);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(frameHtml);
    });
    await new Promise<void>((r) => frameServer.listen(0, "127.0.0.1", r));
    frameOrigin = `http://127.0.0.1:${(frameServer.address() as { port: number }).port}`;

    const hostHtml = readFileSync(join(FIXTURES, "iframe-host.html"), "utf8").replaceAll("{{FRAME_ORIGIN}}", frameOrigin);
    hostServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(hostHtml);
    });
    await new Promise<void>((r) => hostServer.listen(0, "127.0.0.1", r));
    // localhost:portA vs localhost:portB are DIFFERENT origins — the in-page walker
    // cannot see into the frame; only the Node-side graft can.
    hostUrl = `http://127.0.0.1:${(hostServer.address() as { port: number }).port}/`;
    outDir = mkdtempSync(join(tmpdir(), "ditto-iframe-graft-"));
  });

  after(async () => {
    hostServer?.close();
    frameServer?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("grafts the cross-origin form into the snapshot, merges its assets, and generates a <div>", async () => {
    const capture = await captureSite({
      url: hostUrl,
      outDir,
      viewports: [800],
      breakpoints: false,
      screenshots: false,
    });

    // 1) The snapshot carries the grafted subtree under the iframe node.
    const snap = readJSON<PageSnapshot>(join(outDir, "capture", "dom-800.json"));
    const iframe = findFrameNode(snap.root, 0);
    assert.ok(iframe, "the iframe was stamped and captured");
    assert.equal(iframe!.children.length, 1, "the frame document was grafted");
    const wrapper = iframe!.children[0] as RawNode;
    assert.equal(wrapper.tag, "div");

    const findIn = (n: RawNode, pred: (x: RawNode) => boolean): RawNode | null => {
      if (pred(n)) return n;
      for (const c of n.children) {
        if (isText(c)) continue;
        const hit = findIn(c, pred);
        if (hit) return hit;
      }
      return null;
    };
    const input = findIn(wrapper, (n) => n.tag === "input")!;
    assert.ok(input, "the email input is part of the graft");
    assert.equal(input.attrs.id, "f0-email", "frame-internal ids are namespaced");
    assert.equal(input.attrs.placeholder, "Enter your email");
    assert.equal(input.placeholder?.color, "rgb(200, 150, 100)", "::placeholder captured inside the frame");
    // The iframe sits at margin-left:40px — grafted geometry is in page coordinates.
    assert.ok(input.bbox.x >= 40, `input.bbox.x (${input.bbox.x}) offset by the iframe origin`);
    const label = findIn(wrapper, (n) => n.tag === "label")!;
    assert.equal(label.attrs.for, "f0-email");
    const button = findIn(wrapper, (n) => n.tag === "button")!;
    assert.ok(button.visible, "the Sign up button is visible in the graft");

    // 2) The frame's assets flow through the normal pipeline (absolute frame URL, downloaded).
    const pixel = capture.assets.find((a) => a.url === `${frameOrigin}/pixel.png`);
    assert.ok(pixel, "the frame-relative <img> was discovered under the frame's origin");
    assert.ok(pixel!.storedAs, "and its bytes were stored");

    // 3) IR keeps the grafted children as ordinary nodes; generation emits a <div>.
    const ir = buildIR(outDir, [800]);
    const findIr = (n: IRNode, pred: (x: IRNode) => boolean): IRNode | null => {
      if (pred(n)) return n;
      for (const c of n.children) {
        if (isTextChild(c)) continue;
        const hit = findIr(c, pred);
        if (hit) return hit;
      }
      return null;
    };
    const irIframe = findIr(ir.root, (n) => n.tag === "iframe")!;
    assert.ok(irIframe, "iframe survives into the IR");
    assert.ok(irIframe.children.some((c) => !isTextChild(c)), "grafted children survive the IR prune");
    assert.equal(resolveTag(irIframe, false), "div", "a grafted iframe renders as a positioned <div>");
    const props = new Map(propsList(irIframe, new Map(), hostUrl));
    assert.equal(props.get("src"), undefined, "document-loading attrs stay dropped");
    const irInput = findIr(ir.root, (n) => n.tag === "input")!;
    assert.ok(irInput.placeholderByVp?.[800], "placeholder style flows into the IR");
  });
});
