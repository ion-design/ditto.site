import type { IR } from "../normalize/ir.js";
import type { Section } from "../infer/sections.js";
import type { Tokens } from "../infer/tokens.js";
import type { AssetGraph } from "../infer/assets.js";
import type { FontGraph } from "../infer/fonts.js";
import type { CaptureResult } from "../capture/capture.js";
import type { PatternHints } from "../knowledge/patternIndex.js";

export const COMPILER_VERSION = "0.1.0";
export const SCHEMA_VERSION = 1;

export function buildManifest(args: {
  ir: IR;
  sections: Section[];
  tokens: Tokens;
  assetGraph: AssetGraph;
  fontGraph: FontGraph;
  capture: CaptureResult;
  componentCount: number;
  patternHints?: PatternHints;
}): Record<string, unknown> {
  const { ir, sections, tokens, assetGraph, fontGraph, capture, componentCount, patternHints } = args;

  const byType: Record<string, number> = {};
  let downloaded = 0, skipped = 0;
  for (const e of assetGraph.entries) {
    if (e.type === "css") continue;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.classification === "downloaded") downloaded++;
    else skipped++;
  }

  const tokenCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(tokens)) tokenCounts[k] = Object.keys(v).length;

  const scrollHeights: Record<string, number> = {};
  for (const [vp, d] of Object.entries(ir.doc.perViewport)) scrollHeights[vp] = d.scrollHeight;

  return {
    schemaVersion: SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    sourceUrl: ir.doc.sourceUrl,
    capturedAt: capture.capturedAt,
    viewports: ir.doc.viewports,
    canonicalViewport: ir.doc.canonicalViewport,
    doc: {
      title: ir.doc.title,
      lang: ir.doc.lang,
      nodeCount: ir.doc.nodeCount,
      scrollHeights,
    },
    sections: { count: sections.length, ids: sections.map((s) => s.id) },
    tokens: tokenCounts,
    assets: { total: downloaded + skipped, downloaded, skipped, byType },
    fonts: {
      total: fontGraph.entries.length,
      resolved: fontGraph.entries.filter((f) => f.status === "resolved").length,
      fallback: fontGraph.entries.filter((f) => f.status === "fallback").length,
    },
    components: { count: componentCount },
    // Frozen-catalog pattern evidence (hint-only, additive): library/platform fingerprints
    // detected in the IR, with the node cids that carried each signature (bounded pre-order
    // sample). Deterministic — matches are id-sorted and cids are pre-order, so the same
    // catalog + IR yields byte-identical evidence. Generated docs read this to say e.g.
    // "Swiper carousel detected". Omitted when no hints were computed.
    ...(patternHints
      ? {
          patterns: {
            catalogVersion: patternHints.catalogVersion,
            catalogHash: patternHints.catalogHash,
            flags: patternHints.flags,
            platforms: patternHints.platforms,
            simpleStatic: patternHints.simpleStatic,
            matches: patternHints.matches.map((m) => ({ id: m.id, kind: m.kind, count: m.count, cids: m.cids })),
          },
        }
      : {}),
    // Fidelity note: containers whose children were a DIFFERENT SET at some band viewport(s)
    // (content-identity drift — the source deterministically served other content there). The
    // clone shows the canonical-viewport children at those widths (faithful-at-canonical) instead
    // of an empty shell; a perceptual delta against the source at those widths is expected.
    divergence: {
      contentDrift: (ir.doc.contentDrift ?? []).map((d) => ({ id: d.id, tag: d.tag, viewports: d.viewports })),
    },
    // Stage 2: capture-sanity audit — what overlays were dismissed, whether any
    // still covered the page, video stills materialized, and per-viewport quiescence.
    capture: {
      dismissedOverlays: capture.dismissal?.dismissed ?? [],
      overlaysRemoved: capture.dismissal?.removed ?? 0,
      overlaysRemaining: capture.dismissal?.overlaysRemaining ?? 0,
      blockingModal: capture.dismissal?.blocking ?? false,
      videoStills: capture.dismissal?.videoStills ?? 0,
      perViewport: capture.perViewport.map((p) => ({
        viewport: p.viewport, overlaysRemaining: p.overlaysRemaining ?? 0, blocking: p.blocking ?? false, quiescent: p.quiescent ?? null,
      })),
    },
  };
}
