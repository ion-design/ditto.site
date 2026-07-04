/**
 * Multi-route app generation (Stage 3, M2). Composes each captured route into one
 * generated project: a shared root layout/chrome + globals (reset, unioned fonts,
 * tokens, body base), and per route an `app/<seg>/page.tsx` + a route-scoped
 * `ditto.css`. Next loads page-imported CSS only for that route segment; Vite emits
 * separate HTML entries so each route imports its own route CSS. Internal links are
 * rewritten to the generated clone routes (collapsed-collection links → their
 * representative). Assets are content-addressed, so a shared public/ dir dedupes
 * naturally across routes.
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
import { writeText, readJSON, fileExists } from "../util/fsx.js";
import { generateCss, RESET_CSS } from "../generate/css.js";
import { generateInteractionCss } from "../generate/interactionCss.js";
import { buildRuntimeSpecs, wiresJsx, dittoWireImportPath, DITTO_WIRE_TSX, interactionRejectedSet } from "../generate/interactive.js";
import { buildLottieSpec, lottieHasContent, lottieWireJsx, dittoLottieImportPath, DITTO_LOTTIE_TSX } from "../generate/lottie.js";
import { renderChildrenJsx, renderAttrs, buildComponentRegistry, componentPreamble, componentFiles, componentImports, componentDataDecls, summarizeComponents, fileBase, generateViteConfig, generateViteIndexHtml, viteGlobalsCss, cnImportLine, resolveHtmlBg, htmlBgRule, CN_UTILS_MODULE, PACKAGE_JSON, PACKAGE_JSON_TW, PACKAGE_JSON_VITE, PACKAGE_JSON_VITE_TW, TSCONFIG_JSON, TSCONFIG_JSON_VITE, NEXT_CONFIG, injectLottieDep, type AppFramework, type LinkRewrite, type ExtractedComponent, type RenderCtx } from "../generate/app.js";
import { buildTailwind, tailwindGlobalsCss, createColorInterner, colorDefsCssOf, type TailwindOutput } from "../generate/tailwind.js";
import type { InteractionCapture } from "../capture/interactions.js";
import type { IRChild } from "../normalize/ir.js";
import { materializeAssets, type AssetGraph } from "../infer/assets.js";
import { tokensToCss, type Tokens } from "../infer/tokens.js";
import { SYSTEM_FALLBACK, type FontGraph } from "../infer/fonts.js";
import { buildSiteColorPalette, type ColorPalette } from "../infer/semanticTokens.js";
import { recognizePrimitives, inventoryOf } from "../infer/primitives.js";
import type { IR } from "../normalize/ir.js";
import type { CaptureResult } from "../capture/capture.js";
import { backfillLazyBackgrounds } from "../normalize/ir.js";
import { toRoutePath, segmentsOf } from "../crawl/url.js";
import { buildCanonicalChrome, chromeCssIr, middleChildren, middleIncludeFilter, CHROME_PREFIX, type ChromePlan } from "./sharedLayout.js";
import { buildSeoInventory, emitSeoAssetFiles, emitSeoRoutes, jsonLdHeadMarkup, metadataExport, routeSummaryFromIr, seoStaticFiles, SITE_ORIGIN_LAYOUT_IMPORT, SITE_ORIGIN_MODULE, viewportExport, type SeoInventory, type SeoRouteSummary } from "../generate/seo.js";
import { emitGeneratedDocs } from "../generate/docs.js";

export type RouteArtifact = {
  routePath: string; // source path, e.g. "/blog"
  ir: IR;
  assetGraph: AssetGraph;
  fontGraph: FontGraph;
  tokens: Tokens;
  sourceDir: string; // run dir holding assets-store / capture for this route
  capture?: CaptureResult;
  interaction?: InteractionCapture; // Stage 4: hover/focus deltas (opt-in)
};

function sanitizeSeg(s: string): string {
  let out = s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  // Next.js App Router reserves leading "_" (private folders), "(" (route groups),
  // "@" (parallel slots), and bare dot segments — prefix so the route still maps.
  if (out === "" || /^[_(@.]/.test(out)) out = "r-" + out.replace(/^[_(@.]+/, "");
  return out || "r";
}

/** Map a source route path to a sanitized route directory + served href. */
export function routeToSegment(path: string): { dir: string; href: string } {
  const segs = segmentsOf(path).map(sanitizeSeg);
  const dir = segs.join("/");
  return { dir, href: dir ? "/" + dir : "/" };
}

/** Stable key for a route's per-route source/run dir (e.g. "home", "docs__data"). */
export function routeKey(path: string): string {
  if (path === "/") return "home";
  return routeToSegment(path).dir.replace(/\//g, "__") || "home";
}

function buildAssetMap(assetGraph: AssetGraph): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of assetGraph.entries) {
    if (e.classification === "downloaded" && e.localPath && e.type !== "css") m.set(e.sourceUrl, e.localPath);
  }
  return m;
}

function resolveAbs(href: string, base: string): string {
  try { return new URL(href, base).href; } catch { return href; }
}

function unionFontCss(routes: RouteArtifact[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const r of routes) {
    if (!r.fontGraph.css) continue;
    for (const block of r.fontGraph.css.split("\n\n")) {
      const b = block.trim();
      if (b && !seen.has(b)) { seen.add(b); blocks.push(b); }
    }
  }
  return blocks.join("\n\n");
}

/** Shared page-base bits (entry html background + overflow-x clip) — same rationale as
 *  single-page generation; used by both the plain-CSS and Tailwind globals. */
function pageBaseOf(entry: RouteArtifact): { htmlBg: string | null; clip: string } {
  const cw = entry.ir.doc.canonicalViewport;
  const pv = entry.ir.doc.perViewport[cw];
  const htmlBg = resolveHtmlBg(pv);
  const noHScroll = Object.entries(entry.ir.doc.perViewport).every(([vp, d]) => d.scrollWidth <= Number(vp) * 1.03);
  return { htmlBg, clip: noHScroll ? "\nhtml, body { overflow-x: clip; }" : "" };
}

function globalsCss(entry: RouteArtifact, fontCss: string, paletteCss: string): string {
  const { htmlBg, clip } = pageBaseOf(entry);
  return `/* Generated by clone-site. */
${RESET_CSS}
/* fonts (unioned across routes) */
${fontCss}

/* semantic color tokens (site-wide) */
${paletteCss}
/* tokens */
${tokensToCss(entry.tokens, true)}

/* page base */
${htmlBgRule(htmlBg)}body { font-family: ${SYSTEM_FALLBACK}; }${clip}
`;
}

function layoutTsx(entry: RouteArtifact, bodyClass: string | undefined, chrome?: { headerJsx: string; footerJsx: string }, chromePreamble = "", seo?: SeoInventory): string {
  const lang = entry.ir.doc.lang || "en";
  const title = entry.ir.doc.title || "Cloned Site";
  const bodyId = entry.ir.root.id; // "0" — body is the IR root on every route
  const chromeImport = chrome ? `import "./ditto-chrome.css";\n` : "";
  const header = chrome && chrome.headerJsx ? chrome.headerJsx + "\n" : "";
  const footer = chrome && chrome.footerJsx ? "\n" + chrome.footerJsx : "";
  const pre = chromePreamble ? chromePreamble + "\n\n" : "";
  const bodyAttrs = renderAttrs(bodyClass
    ? [["className", JSON.stringify(bodyClass)], ['"data-cid"', JSON.stringify(bodyId)]]
    : [['"data-cid"', JSON.stringify(bodyId)]]);
  const metadata = seo ? metadataExport(seo) : `export const metadata = { title: ${JSON.stringify(title)} };\n`;
  const viewport = seo ? viewportExport(seo) : `export const viewport = { width: "device-width", initialScale: 1 };\n`;
  const jsonLd = seo ? jsonLdHeadMarkup(seo, 8) : "";
  const head = jsonLd ? `      <head>\n${jsonLd}\n      </head>\n` : "";
  const siteImport = seo ? SITE_ORIGIN_LAYOUT_IMPORT + "\n" : "";
  return `import "./globals.css";
${chromeImport}import type { ReactNode } from "react";
${siteImport}
${metadata}${viewport}

${pre}export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={${JSON.stringify(lang)}}>
${head}      <body${bodyAttrs}>
${header}        {children}${footer}
      </body>
    </html>
  );
}
`;
}

function chromeTsx(chrome: { headerJsx: string; footerJsx: string }, chromePreamble = ""): string {
  const header = chrome.headerJsx ? chrome.headerJsx + "\n" : "";
  const footer = chrome.footerJsx ? "\n" + chrome.footerJsx : "";
  const pre = chromePreamble ? chromePreamble + "\n\n" : "";
  return `import type { ReactNode } from "react";

${pre}export default function Chrome({ children }: { children: ReactNode }) {
  return (
    <>
${header}      {children}${footer}
    </>
  );
}
`;
}

function viteRouteMain(hasChrome: boolean): string {
  const chromeImport = hasChrome ? 'import "../../ditto-chrome.css";\nimport Chrome from "../../Chrome";\n' : "";
  const body = hasChrome ? "<Chrome><Page /></Chrome>" : "<Page />";
  return `import { createRoot } from "react-dom/client";
import "../../globals.css";
${chromeImport}import "./ditto.css";
import Page from "./page";

createRoot(document.getElementById("root")!).render(${body});
`;
}

function viteHtmlPathForHref(href: string): string {
  const clean = href.replace(/^\/+/, "").replace(/\/+$/, "");
  return clean ? join(clean, "index.html") : "index.html";
}

export type SiteExtraction = {
  chrome: ExtractedComponent[]; // components extracted from the hoisted header/footer
  routes: Array<{ routePath: string; href: string; components: ExtractedComponent[] }>;
};

export type SiteGenResult = {
  routes: Array<{ routePath: string; href: string; dir: string; nodeCount: number }>;
  assetsCopied: number;
  assetsMissing: number;
  components: { count: number; byType: Record<string, number> }; // recognized primitives, site-wide
  extracted: SiteExtraction; // Stage 4.5: promoted components per route + chrome
  seoInventory: SeoInventory;
};

/** A throwaway IR rooted at `ir`'s body but with only the given children — used to run
 *  component detection over exactly the node set a file will render (a route's middle,
 *  or the hoisted chrome), without seeing the rest of the page. */
function subtreeIr(ir: IR, children: IRChild[]): IR {
  return { doc: ir.doc, root: { ...ir.root, children } };
}

/**
 * Generate the whole multi-route app. `linkTargets` maps a source route path to the
 * clone href to use for internal links (selected routes → themselves; collapsed
 * collection instances → their representative's href).
 */
export function generateSiteApp(opts: {
  appDir: string;
  routes: RouteArtifact[];
  linkTargets: Map<string, string>;
  origin: string;
  entryRoutePath: string;
  chrome?: ChromePlan; // shared header/footer hoisting (M4); omitted ⇒ full per-route pages
  components?: boolean; // Stage 4.5: extract repeated subtrees per route + chrome (opt-in)
  humanizeMode?: "tailwind" | "css"; // styling output: Tailwind utilities (default) or per-node CSS
  framework?: AppFramework; // output framework: Next.js App Router (default) or Vite React MPA
  reflow?: boolean; // Reflow trade: flow ALL heights (matches single-page default); Tailwind path only
}): SiteGenResult {
  const { appDir, routes, linkTargets, origin } = opts;
  const framework = opts.framework ?? "next";
  const isVite = framework === "vite";
  for (const r of routes) backfillLazyBackgrounds(r.ir);
  const entry = routes.find((r) => r.routePath === opts.entryRoutePath) ?? routes[0]!;
  const seoInventory = buildSeoInventory(entry.ir, entry.assetGraph, entry.capture);
  const seoRoutes: SeoRouteSummary[] = routes.map((route) => {
    const { href } = routeToSegment(route.routePath);
    return routeSummaryFromIr(route.ir, route.routePath, href, origin + (route.routePath === "/" ? "/" : route.routePath));
  });
  const plan = opts.chrome && (opts.chrome.headerCount > 0 || opts.chrome.footerCount > 0) ? opts.chrome : null;
  // Stage 3.5: one site-wide semantic color palette shared by every route + chrome.
  const palette: ColorPalette = buildSiteColorPalette(routes.map((r) => r.ir), entry.ir);

  // Stage 7.1: Tailwind utilities are the default styling output (humanizeMode:"css" keeps
  // the legacy per-node CSS). One color interner is shared across the chrome + every route
  // so a color mints ONE site-wide --clr-N token (a single @theme in globals). Chrome is
  // built over its namespaced (L-prefixed) IR; routes over their middle (chrome excluded).
  const tw = opts.humanizeMode !== "css";
  const interner = createColorInterner();
  const canonical = plan ? buildCanonicalChrome(entry.ir, plan) : null;
  const bodyId = entry.ir.root.id;
  // The body (IR root) is a SHARED layout element but its computed style is PER-ROUTE, so
  // it can't ride a shared utility className. In both modes it keeps the legacy route-scoped
  // `.c<id>` rule (emitted into each route's ditto.css below); the Tailwind builds therefore
  // EXCLUDE the body, and the chrome build (identical across routes) excludes it too.
  const bodyClass = "c" + bodyId;
  const twChrome = tw && plan && canonical
    ? buildTailwind(chromeCssIr(entry.ir, canonical), buildAssetMap(entry.assetGraph), palette.varForColor, { interner, includeNode: (id) => canonical.ids.has(id), reflow: !!opts.reflow })
    : undefined;
  const twByRoute = new Map<string, TailwindOutput>();
  if (tw) for (const route of routes) {
    const rootId = route.ir.root.id;
    const mid = plan ? middleIncludeFilter(route.ir, plan) : undefined;
    const include = (id: string) => id !== rootId && (mid ? mid(id) : true);
    twByRoute.set(route.routePath, buildTailwind(route.ir, buildAssetMap(route.assetGraph), palette.varForColor, { interner, includeNode: include, reflow: !!opts.reflow }));
  }

  const linkRewriteFor = (routePath: string): LinkRewrite => {
    const base = origin + routePath;
    return (raw) => {
      const p = toRoutePath(raw, base);
      if (p && linkTargets.has(p)) return linkTargets.get(p)!;
      return resolveAbs(raw, base);
    };
  };

  // Shared scaffold (written once).
  // package.json is written after the route loop (below) so the lottie-web dependency can be
  // added when any route actually replays a Lottie animation.
  writeText(join(appDir, "tsconfig.json"), isVite ? TSCONFIG_JSON_VITE : TSCONFIG_JSON);
  writeText(join(appDir, "src", "lib", "utils.ts"), CN_UTILS_MODULE);
  // SITE_ORIGIN constant for SEO/metadata routes (Next only — Vite ships static SEO files).
  if (!isVite) writeText(join(appDir, "src", "lib", "site.ts"), SITE_ORIGIN_MODULE);
  writeText(join(appDir, ".gitignore"), "node_modules\n.next\nout\ndist\n");
  if (isVite) {
    rmSync(join(appDir, "next.config.mjs"), { force: true });
    rmSync(join(appDir, "next-env.d.ts"), { force: true });
    rmSync(join(appDir, "src", "app"), { recursive: true, force: true });
    writeText(join(appDir, "src", "vite-env.d.ts"), `/// <reference types="vite/client" />\n`);
  } else {
    rmSync(join(appDir, "index.html"), { force: true });
    rmSync(join(appDir, "vite.config.ts"), { force: true });
    rmSync(join(appDir, "src", "routes"), { recursive: true, force: true });
    rmSync(join(appDir, "src", "vite-env.d.ts"), { force: true });
    writeText(join(appDir, "next.config.mjs"), NEXT_CONFIG);
    writeText(join(appDir, "next-env.d.ts"), `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`);
  }
  if (tw) writeText(join(appDir, "postcss.config.mjs"), `export default { plugins: { "@tailwindcss/postcss": {} } };\n`);
  // globals.css is written LAST (after the chrome + route builds populate the shared
  // interner, so the Tailwind @theme can bind every minted color token).

  // Shared chrome (M4): hoist the common header/footer into the layout, emitted once.
  let chromeJsx: { headerJsx: string; footerJsx: string } | undefined;
  let chromePreamble = "";
  const extracted: SiteExtraction = { chrome: [], routes: [] };
  if (plan && canonical) {
    const entryAssetMap = buildAssetMap(entry.assetGraph);
    const entryRewrite = linkRewriteFor(entry.routePath);
    const entryBase = origin + entry.routePath;
    // Detect within the (namespaced) chrome nodes only, so chrome components live in
    // the layout and carry their L-prefixed cids — render-identical to inline chrome.
    const chromeReg = opts.components ? buildComponentRegistry(subtreeIr(entry.ir, [...canonical.header, ...canonical.footer])) : undefined;
    const entryCtx: RenderCtx = { linkRewrite: entryRewrite, primitives: recognizePrimitives(entry.ir), components: chromeReg, classOf: twChrome ? (cid) => twChrome.classOf.get(cid) : undefined, styleOf: twChrome ? (cid) => twChrome.styleOf.get(cid) : undefined };
    chromeJsx = {
      headerJsx: renderChildrenJsx(canonical.header, entryAssetMap, entryBase, 4, entryCtx),
      footerJsx: renderChildrenJsx(canonical.footer, entryAssetMap, entryBase, 4, entryCtx),
    };
    if (chromeReg) { chromePreamble = componentPreamble(chromeReg); extracted.chrome = summarizeComponents(chromeReg); }
    // Stage 4: hoisted-chrome hover/focus. Entry deltas map to bare cids; chrome is
    // rendered with namespaced (L-prefixed) cids. Tailwind keys interaction CSS by
    // [data-cid="L<id>"]; the legacy path emits `.cL<id>` via the prefix option.
    const chromeInteractionCss = generateInteractionCss(entry.ir, entry.interaction, {
      include: (id) => canonical.ids.has(CHROME_PREFIX + id),
      ...(tw ? { selector: (cid: string) => `[data-cid="${CHROME_PREFIX}${cid}"]` } : { prefix: CHROME_PREFIX }),
    });
    const chromeCss = twChrome
      ? twChrome.pseudoCss + chromeInteractionCss
      : generateCss(chromeCssIr(entry.ir, canonical), entryAssetMap, (id) => canonical.ids.has(id), palette.varForColor) + chromeInteractionCss;
    writeText(join(appDir, "src", isVite ? "ditto-chrome.css" : join("app", "ditto-chrome.css")), chromeCss);
  }
  if (isVite) {
    if (chromeJsx) writeText(join(appDir, "src", "Chrome.tsx"), chromeTsx(chromeJsx, chromePreamble));
  } else {
    writeText(join(appDir, "src", "app", "layout.tsx"), layoutTsx(entry, bodyClass, chromeJsx, chromePreamble, seoInventory));
  }

  let assetsCopied = 0;
  let assetsMissing = 0;
  let anyWires = false;
  let anyLottie = false;
  const outRoutes: SiteGenResult["routes"] = [];
  const components = { count: 0, byType: {} as Record<string, number> };
  const materializedAssets = new Set<string>();
  const viteEntries: Array<{ name: string; html: string }> = [];

  for (const route of routes) {
    const { dir, href } = routeToSegment(route.routePath);
    const base = origin + route.routePath;
    const assetMap = buildAssetMap(route.assetGraph);
    const routePrims = recognizePrimitives(route.ir);
    const twRoute = twByRoute.get(route.routePath);
    const ctx: RenderCtx = { linkRewrite: linkRewriteFor(route.routePath), primitives: routePrims, classOf: twRoute ? (cid) => twRoute.classOf.get(cid) : undefined, styleOf: twRoute ? (cid) => twRoute.styleOf.get(cid) : undefined };
    const inv = inventoryOf(route.ir, routePrims);
    components.count += inv.count;
    for (const [t, n] of Object.entries(inv.byType)) components.byType[t] = (components.byType[t] ?? 0) + n;

    const include = plan ? middleIncludeFilter(route.ir, plan) : undefined;
    // The exact node set this page renders (route-unique middle when chrome is hoisted,
    // else the whole body) — also the scope for component detection.
    const renderKids = plan ? middleChildren(route.ir, plan) : route.ir.root.children;
    const routeReg = opts.components ? buildComponentRegistry(subtreeIr(route.ir, renderKids)) : undefined;
    if (routeReg) ctx.components = routeReg;
    const bodyJsx = renderChildrenJsx(renderKids, assetMap, base, 3, ctx);
    // Tailwind: utilities are in the JSX; ditto.css carries only pseudo/raw + interaction
    // (keyed by [data-cid]). Legacy CSS: per-node rules + interaction (.c<id>).
    const interactionCss = generateInteractionCss(route.ir, route.interaction, tw ? { include, selector: (cid: string) => `[data-cid="${cid}"]` } : { include });
    // Tailwind: utilities live in the JSX; ditto.css carries the body's route-scoped `.c<id>`
    // rule (shared element, per-route style) + pseudo/raw + interaction (keyed by [data-cid]).
    const bodyCss = twRoute ? generateCss(route.ir, assetMap, (id) => id === route.ir.root.id, palette.varForColor) : "";
    const cloneCss = twRoute
      ? bodyCss + twRoute.pseudoCss + interactionCss
      : generateCss(route.ir, assetMap, include, palette.varForColor) + interactionCss;
    if (routeReg) extracted.routes.push({ routePath: route.routePath, href, components: summarizeComponents(routeReg) });
    // M2: recognized interactive patterns (tabs/accordion) in the route body.
    // Honor the interaction gate's verdict: patterns it rejected for this route are
    // left static (read from the route's source dir).
    const rejPath = join(route.sourceDir, "interaction-rejected.json");
    const rejected = fileExists(rejPath) ? interactionRejectedSet(readJSON<unknown>(rejPath)) : undefined;
    const wires = buildRuntimeSpecs(route.ir, route.interaction, include, rejected);
    const depth = isVite ? 2 : (dir ? dir.split("/").length : 0);
    const wireImport = wires.length ? `import DittoWire from "${dittoWireImportPath(depth)}";\n` : "";
    const wireBody = wires.length ? "\n" + wiresJsx(wires, 3) : "";
    if (wires.length) anyWires = true;
    // Lottie replay for this route (third-party JSON animations). Same per-route shape as wires.
    const lottieSpec = buildLottieSpec(route.ir, route.capture?.motion, route.assetGraph, include);
    const hasLottie = lottieHasContent(lottieSpec);
    const lottieImport = hasLottie ? `import DittoLottie from "${dittoLottieImportPath(depth)}";\n` : "";
    const lottieBody = hasLottie ? "\n" + lottieWireJsx(lottieSpec, 3) : "";
    if (hasLottie) anyLottie = true;
    const rKey = routeKey(route.routePath);
    const routeDir = isVite
      ? join(appDir, "src", "routes", rKey)
      : (dir ? join(appDir, "src", "app", dir) : join(appDir, "src", "app"));
    // Stage 6: split each route component into its own route-local `components/Name.tsx`
    // (page imports them); per-route data stays inline. Route-local dirs keep names from
    // colliding across routes, which each name their components independently.
    // Depth of a route-local `components/Name.tsx` below `src`: src/app/<dir>/components
    // (Next) or src/routes/<key>/components (Vite). +1 for the components dir itself.
    const compDepth = (isVite ? 2 : (dir ? dir.split("/").length + 1 : 1)) + 1;
    for (const { name, module } of componentFiles(routeReg, undefined, compDepth)) writeText(join(routeDir, "components", fileBase(name) + ".tsx"), module);
    const compImport = componentImports(routeReg, 0); // route-local → ./components/Name
    const dataDecls = componentDataDecls(routeReg);
    const preBlock = dataDecls ? dataDecls + "\n\n" : "";
    // page.tsx sits at routeDir (src/app/<dir> or src/routes/<key>); depth below src.
    const pageDepth = isVite ? 2 : (dir ? dir.split("/").length + 1 : 1);
    const cnImport = /\bcn\(/.test(bodyJsx) ? cnImportLine(pageDepth) + "\n" : "";
    const importLines = [wireImport.trimEnd(), lottieImport.trimEnd(), cnImport.trimEnd(), compImport].filter(Boolean).join("\n");
    const pageTsx = `${isVite ? "" : 'import "./ditto.css";\n'}${importLines ? importLines + "\n" : ""}// Generated by clone-site. Do not edit by hand.\n${preBlock}export default function Page() {\n  return (\n    <>\n${bodyJsx}${wireBody}${lottieBody}
    </>
  );
}
`;
    writeText(join(routeDir, "page.tsx"), pageTsx);
    writeText(join(routeDir, "ditto.css"), cloneCss);
    if (isVite) {
      writeText(join(routeDir, "main.tsx"), viteRouteMain(!!chromeJsx));
      const htmlPath = viteHtmlPathForHref(href);
      const summary = seoRoutes.find((r) => r.routePath === route.routePath);
      writeText(join(appDir, htmlPath), generateViteIndexHtml({
        lang: route.ir.doc.lang || entry.ir.doc.lang || "en",
        bodyCid: route.ir.root.id,
        bodyClass,
        seo: route.routePath === opts.entryRoutePath ? seoInventory : undefined,
        title: summary?.title || route.ir.doc.title || "Cloned Page",
        description: summary?.description || route.ir.doc.head?.description,
        entry: `/src/routes/${rKey}/main.tsx`,
      }));
      viteEntries.push({ name: rKey, html: htmlPath });
    }

    const mat = materializeAssets(route.assetGraph, route.sourceDir, join(appDir, "public"), materializedAssets);
    assetsCopied += mat.copied;
    assetsMissing += mat.missing.length;
    outRoutes.push({ routePath: route.routePath, href, dir, nodeCount: route.ir.doc.nodeCount });
  }
  if (anyWires) writeText(join(appDir, "src", isVite ? "ditto" : join("app", "ditto"), "DittoWire.tsx"), DITTO_WIRE_TSX);
  if (anyLottie) writeText(join(appDir, "src", isVite ? "ditto" : join("app", "ditto"), "DittoLottie.tsx"), DITTO_LOTTIE_TSX);
  // Deferred package.json — inject lottie-web only when a route replays a Lottie animation.
  const sitePkg = isVite ? (tw ? PACKAGE_JSON_VITE_TW : PACKAGE_JSON_VITE) : (tw ? PACKAGE_JSON_TW : PACKAGE_JSON);
  writeText(join(appDir, "package.json"), anyLottie ? injectLottieDep(sitePkg) : sitePkg);
  if (isVite) {
    writeText(join(appDir, "vite.config.ts"), generateViteConfig(viteEntries));
    for (const [rel, body] of seoStaticFiles(seoInventory, seoRoutes)) writeText(join(appDir, "public", rel), body);
  } else {
    emitSeoRoutes(appDir, seoInventory, seoRoutes);
    emitSeoAssetFiles(appDir, entry.sourceDir, entry.assetGraph, seoInventory);
  }

  // globals.css written last: the shared interner is now fully populated, so the Tailwind
  // @theme binds every minted color token. (Legacy CSS mode emits the per-node globals.)
  if (tw) {
    const { htmlBg, clip } = pageBaseOf(entry);
    const tokensCss = palette.css + "\n" + tokensToCss(entry.tokens, true) + (interner.defs.size ? "\n" + colorDefsCssOf(interner) : "");
    const globals = tailwindGlobalsCss({
      reset: RESET_CSS, fontCss: unionFontCss(routes), tokensCss, htmlBg, bodyFont: SYSTEM_FALLBACK, clip,
      colorTokens: [...interner.tokens], viewports: entry.ir.doc.viewports,
      canonical: entry.ir.doc.canonicalViewport,
    });
    writeText(join(appDir, "src", isVite ? "globals.css" : join("app", "globals.css")), isVite ? viteGlobalsCss(globals) : globals);
  } else {
    const globals = globalsCss(entry, unionFontCss(routes), palette.css);
    writeText(join(appDir, "src", isVite ? "globals.css" : join("app", "globals.css")), isVite ? viteGlobalsCss(globals) : globals);
  }
  emitGeneratedDocs(appDir, {
    sourceUrl: entry.ir.doc.sourceUrl,
    routes: seoRoutes,
    styling: tw ? "tailwind" : "css",
    framework,
    multiRoute: true,
    components: !!opts.components,
    sectionCount: 0,
    componentCount: extracted.chrome.length + extracted.routes.reduce((sum, route) => sum + route.components.length, 0),
    svgCount: 0,
    hasContentModule: false,
    runtimeUtilities: [...(anyWires ? ["DittoWire"] : []), ...(anyLottie ? ["DittoLottie"] : [])],
  });

  return { routes: outRoutes, assetsCopied, assetsMissing, components, extracted, seoInventory };
}
