import type { InteractionCapture } from "../capture/interactions.js";
import type { IR, IRNode, BBox } from "../normalize/ir.js";
import { isTextChild } from "../normalize/ir.js";
import type { Section } from "./sections.js";

export type InteractionRecipeKind = "dropdown-menu" | "nav-menu" | "accordion" | "mobile-menu" | "tablist";
export type InteractionRecipeSource = "capture-pattern" | "mount-on-open" | "native-details" | "aria" | "structural";
export type InteractionMode = "click" | "hover" | "native" | "mixed" | "unknown";
export type InteractionEmissionStatus = "report-only" | "semantic-runtime" | "deferred";
export type InteractionRecipeRisk = "low" | "medium" | "high";

export type InteractionPair = {
  triggerCid: string;
  panelCid?: string;
  triggerText?: string;
  panelTextSample?: string;
};

export type InteractionRecipeCandidate = {
  id: string;
  kind: InteractionRecipeKind;
  confidence: number;
  risk: InteractionRecipeRisk;
  source: InteractionRecipeSource;
  rootCid: string;
  rootTag: string;
  sectionId?: string;
  sectionRole?: string;
  triggerCid?: string;
  panelCid?: string;
  triggerCount: number;
  panelCount: number;
  itemCount: number;
  componentName: "DropdownMenu" | "NavMenu" | "Accordion" | "MobileMenu" | "Tabs";
  interactionMode: InteractionMode;
  preservedDom: boolean;
  triggerPanelPairs: InteractionPair[];
  accessibility: {
    nativeDetails: boolean;
    ariaExpanded: boolean;
    ariaControls: boolean;
    ariaHaspopup: boolean;
    roles: string[];
  };
  sourceHints: string[];
  signals: string[];
  emissionStatus: InteractionEmissionStatus;
  fallbackReason: string;
};

export type InteractionRecipeReport = {
  version: 1;
  sourceUrl: string;
  canonicalViewport: number;
  viewports: number[];
  summary: {
    totalCandidates: number;
    highConfidence: number;
    byKind: Record<string, number>;
    bySource: Record<string, number>;
    semanticRuntime: number;
    reportOnly: number;
    deferred: number;
  };
  candidates: InteractionRecipeCandidate[];
};

type ParentMap = Map<string, IRNode | undefined>;

type Context = {
  ir: IR;
  cw: number;
  nodes: IRNode[];
  byId: Map<string, IRNode>;
  byHtmlId: Map<string, IRNode>;
  capToNode: Map<string, IRNode>;
  parentById: ParentMap;
  sectionByNodeId: Map<string, Section>;
};

type Draft = Omit<InteractionRecipeCandidate, "id">;

const SOURCE_HINT = /\b(?:nav|navbar|menu|dropdown|popover|flyout|mega|drawer|mobile|hamburger|accordion|faq|details|summary|tabs?|tablist|dialog|modal|overlay|locale|language|search)\b/i;
const MOBILE_PANEL_HINT = /\b(?:mobile-menu|mobile_nav|mobile-nav|drawer|offcanvas|side-menu|menu-drawer|nav-drawer|hamburger|fullscreen-menu)\b/i;
const TRIGGER_HINT = /\b(?:menu|hamburger|toggle|open|drawer|nav|dropdown|locale|language|search)\b/i;

function round(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

function riskOf(confidence: number): InteractionRecipeRisk {
  return confidence >= 0.86 ? "low" : confidence >= 0.74 ? "medium" : "high";
}

function elementChildren(n: IRNode): IRNode[] {
  return n.children.filter((c): c is IRNode => !isTextChild(c));
}

function textContent(n: IRNode | undefined, max = 240): string {
  if (!n) return "";
  let out = "";
  const walk = (node: IRNode): void => {
    if (out.length >= max) return;
    for (const c of node.children) {
      if (isTextChild(c)) out += " " + c.text;
      else walk(c);
      if (out.length >= max) return;
    }
  };
  walk(n);
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function directText(n: IRNode | undefined, max = 96): string {
  if (!n) return "";
  return n.children
    .filter(isTextChild)
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isLikelySkipTrigger(n: IRNode, gap?: number): boolean {
  const label = `${textContent(n, 120)} ${n.attrs["aria-label"] ?? ""}`.toLowerCase();
  const href = (n.attrs.href ?? "").trim();
  if (/\bskip\s+(?:to\s+)?(?:content|main|navigation)\b/.test(label)) return true;
  return !!gap && href.startsWith("#") && gap > 360;
}

function visibleAt(n: IRNode, vp: number): boolean {
  const b = n.bboxByVp[vp];
  return !!n.visibleByVp[vp] && !!b && b.width > 1 && b.height > 1;
}

function boxAt(n: IRNode | undefined, vp: number): BBox | undefined {
  return n?.bboxByVp[vp];
}

function attrText(n: IRNode | undefined): string {
  if (!n) return "";
  return [n.tag, n.srcClass ?? "", ...Object.entries(n.attrs).map(([k, v]) => `${k}=${v}`)].join(" ");
}

function sourceHints(root: IRNode | undefined): string[] {
  if (!root) return [];
  const hints = new Set<string>();
  const walk = (n: IRNode): void => {
    if (hints.size >= 16) return;
    for (const value of [n.srcClass ?? "", n.attrs.id ?? "", n.attrs.role ?? "", n.attrs["aria-label"] ?? ""]) {
      for (const token of value.split(/\s+/)) {
        if (SOURCE_HINT.test(token)) hints.add(token);
        if (hints.size >= 16) break;
      }
    }
    for (const c of elementChildren(n)) walk(c);
  };
  walk(root);
  return [...hints].sort();
}

function buildContext(ir: IR, sections: Section[]): Context {
  const nodes: IRNode[] = [];
  const byId = new Map<string, IRNode>();
  const byHtmlId = new Map<string, IRNode>();
  const capToNode = new Map<string, IRNode>();
  const parentById: ParentMap = new Map();
  const walk = (n: IRNode, parent: IRNode | undefined): void => {
    nodes.push(n);
    byId.set(n.id, n);
    parentById.set(n.id, parent);
    if (n.attrs.id) byHtmlId.set(n.attrs.id, n);
    if (n.attrs["data-cid-cap"] !== undefined) capToNode.set(n.attrs["data-cid-cap"], n);
    for (const c of elementChildren(n)) walk(c, n);
  };
  walk(ir.root, undefined);
  return {
    ir,
    cw: ir.doc.canonicalViewport,
    nodes,
    byId,
    byHtmlId,
    capToNode,
    parentById,
    sectionByNodeId: new Map(sections.map((s) => [s.nodeId, s])),
  };
}

function nearestSection(ctx: Context, n: IRNode | undefined): Section | undefined {
  let cur = n;
  while (cur) {
    const section = ctx.sectionByNodeId.get(cur.id);
    if (section) return section;
    cur = ctx.parentById.get(cur.id);
  }
  return undefined;
}

function nearestCommonAncestor(ctx: Context, nodes: IRNode[]): IRNode | undefined {
  if (!nodes.length) return undefined;
  const chains = nodes.map((n) => {
    const out: IRNode[] = [];
    let cur: IRNode | undefined = n;
    while (cur) { out.push(cur); cur = ctx.parentById.get(cur.id); }
    return out;
  });
  for (const candidate of chains[0] ?? []) {
    if (chains.every((chain) => chain.some((n) => n.id === candidate.id))) return candidate;
  }
  return nodes[0];
}

function isInNav(ctx: Context, n: IRNode | undefined): boolean {
  let cur = n;
  let depth = 0;
  while (cur && depth < 8) {
    if (cur.tag === "nav" || cur.tag === "header" || cur.attrs.role === "navigation") return true;
    if (/\b(?:nav|navbar|globalnav|header|menu-bar|menubar)\b/i.test(attrText(cur))) return true;
    cur = ctx.parentById.get(cur.id);
    depth++;
  }
  return false;
}

function isLikelyMobilePanel(ctx: Context, n: IRNode | undefined): boolean {
  if (!n) return false;
  const t = attrText(n);
  if (MOBILE_PANEL_HINT.test(t)) return true;
  const cs = n.computedByVp[ctx.cw];
  const b = boxAt(n, ctx.cw);
  const vpH = ctx.ir.doc.perViewport[ctx.cw]?.scrollHeight ? Math.min(ctx.ir.doc.perViewport[ctx.cw]!.scrollHeight, 1200) : 800;
  if (!cs || !b) return false;
  const fixedFull = cs.position === "fixed" && b.width >= ctx.cw * 0.75 && b.height >= vpH * 0.65;
  return fixedFull && /\b(?:menu|nav|drawer|overlay|dialog|modal)\b/i.test(t);
}

function findMobileTrigger(ctx: Context, panel: IRNode): IRNode | undefined {
  const panelText = textContent(panel, 500).toLowerCase();
  const candidates = ctx.nodes
    .filter((n) => visibleAt(n, ctx.cw))
    .filter((n) => {
      if (!/^(button|a|div|span)$/.test(n.tag) && n.attrs.role !== "button") return false;
      const b = boxAt(n, ctx.cw);
      if (!b || b.y > 180 || b.width < 8 || b.height < 8) return false;
      const t = `${attrText(n)} ${textContent(n, 80)}`;
      if (TRIGGER_HINT.test(t) && /\b(?:mobile|menu|hamburger|nav|drawer)\b/i.test(t)) return true;
      const label = (n.attrs["aria-label"] ?? "").toLowerCase();
      return label.includes("menu") || label.includes("navigation");
    })
    .sort((a, b) => (boxAt(a, ctx.cw)?.y ?? 0) - (boxAt(b, ctx.cw)?.y ?? 0) || (boxAt(a, ctx.cw)?.x ?? 0) - (boxAt(b, ctx.cw)?.x ?? 0));
  return candidates.find((n) => {
    const text = textContent(n, 80).toLowerCase();
    return !text || !panelText.includes(text) || text.length <= 20;
  }) ?? candidates[0];
}

function rolesOf(nodes: Array<IRNode | undefined>): string[] {
  return [...new Set(nodes.map((n) => n?.attrs.role).filter((x): x is string => !!x))].sort();
}

function componentNameFor(kind: InteractionRecipeKind): InteractionRecipeCandidate["componentName"] {
  switch (kind) {
    case "dropdown-menu": return "DropdownMenu";
    case "nav-menu": return "NavMenu";
    case "accordion": return "Accordion";
    case "mobile-menu": return "MobileMenu";
    case "tablist": return "Tabs";
  }
}

function statusFor(kind: InteractionRecipeKind, source: InteractionRecipeSource): { status: InteractionEmissionStatus; reason: string } {
  if (kind === "accordion" && source === "capture-pattern") {
    return { status: "semantic-runtime", reason: "captured accordion is emitted through the small Accordion runtime component" };
  }
  if ((kind === "dropdown-menu" || kind === "nav-menu") && source === "mount-on-open") {
    return { status: "semantic-runtime", reason: "captured mount-on-open menu is emitted through the DropdownMenu runtime component" };
  }
  if (kind === "mobile-menu") return { status: "report-only", reason: "mobile overlay structure is detected; semantic MobileMenu DOM emission is deferred" };
  if (kind === "tablist") return { status: "report-only", reason: "tablist relationships are detected; semantic Tabs emission is deferred" };
  return { status: "report-only", reason: "recognized for inventory; existing measured DOM remains the fallback" };
}

function makeDraft(ctx: Context, init: {
  kind: InteractionRecipeKind;
  source: InteractionRecipeSource;
  confidence: number;
  root: IRNode;
  trigger?: IRNode;
  panel?: IRNode;
  pairs: InteractionPair[];
  mode: InteractionMode;
  preservedDom: boolean;
  signals: string[];
  accessibilityNodes?: Array<IRNode | undefined>;
}): Draft {
  const section = nearestSection(ctx, init.root);
  const status = statusFor(init.kind, init.source);
  const nodes = init.accessibilityNodes ?? [init.trigger, init.panel, init.root];
  return {
    kind: init.kind,
    confidence: round(init.confidence),
    risk: riskOf(init.confidence),
    source: init.source,
    rootCid: init.root.id,
    rootTag: init.root.tag,
    ...(section ? { sectionId: section.id, sectionRole: section.role } : {}),
    ...(init.trigger ? { triggerCid: init.trigger.id } : {}),
    ...(init.panel ? { panelCid: init.panel.id } : {}),
    triggerCount: init.pairs.filter((p) => p.triggerCid).length,
    panelCount: init.pairs.filter((p) => p.panelCid).length,
    itemCount: Math.max(1, init.pairs.length),
    componentName: componentNameFor(init.kind),
    interactionMode: init.mode,
    preservedDom: init.preservedDom,
    triggerPanelPairs: init.pairs,
    accessibility: {
      nativeDetails: init.root.tag === "details" || nodes.some((n) => n?.tag === "details"),
      ariaExpanded: nodes.some((n) => n?.attrs["aria-expanded"] !== undefined),
      ariaControls: nodes.some((n) => n?.attrs["aria-controls"] !== undefined),
      ariaHaspopup: nodes.some((n) => n?.attrs["aria-haspopup"] !== undefined),
      roles: rolesOf(nodes),
    },
    sourceHints: sourceHints(init.root),
    signals: init.signals,
    emissionStatus: status.status,
    fallbackReason: status.reason,
  };
}

function pairOf(trigger?: IRNode, panel?: IRNode): InteractionPair[] {
  if (!trigger && !panel) return [];
  return [{
    ...(trigger ? { triggerCid: trigger.id, triggerText: textContent(trigger, 80) || trigger.attrs["aria-label"] || directText(trigger) } : { triggerCid: "" }),
    ...(panel ? { panelCid: panel.id, panelTextSample: textContent(panel, 100) } : {}),
  }].filter((p) => p.triggerCid || p.panelCid);
}

function fromCapturePatterns(ctx: Context, interaction: InteractionCapture | undefined): Draft[] {
  const out: Draft[] = [];
  for (const pattern of interaction?.patterns ?? []) {
    if (pattern.kind === "accordion") {
      const triggers = pattern.items.map((i) => ctx.capToNode.get(i.triggerCap)).filter((n): n is IRNode => !!n);
      const panels = pattern.items.map((i) => ctx.capToNode.get(i.regionCap)).filter((n): n is IRNode => !!n);
      const root = ctx.capToNode.get(pattern.rootCap) ?? nearestCommonAncestor(ctx, [...triggers, ...panels]) ?? triggers[0] ?? panels[0];
      if (!root || !triggers.length || !panels.length) continue;
      out.push(makeDraft(ctx, {
        kind: "accordion",
        source: "capture-pattern",
        confidence: 0.93,
        root,
        trigger: triggers[0],
        panel: panels[0],
        pairs: pattern.items.map((i) => pairOf(ctx.capToNode.get(i.triggerCap), ctx.capToNode.get(i.regionCap))[0]).filter((p): p is InteractionPair => !!p),
        mode: "click",
        preservedDom: true,
        accessibilityNodes: [...triggers, ...panels, root],
        signals: [
          `${pattern.items.length} captured trigger/region pair(s)`,
          "open and closed styles were driven and stored in interaction.json",
          pattern.items.some((i) => i.expandedAtBase) ? "source has an expanded base item" : "source base state is collapsed",
        ],
      }));
    } else if (pattern.kind === "tabs") {
      const triggers = pattern.tabs.map((i) => ctx.capToNode.get(i.triggerCap)).filter((n): n is IRNode => !!n);
      const panels = pattern.tabs.map((i) => ctx.capToNode.get(i.panelCap)).filter((n): n is IRNode => !!n);
      const root = ctx.capToNode.get(pattern.rootCap) ?? nearestCommonAncestor(ctx, [...triggers, ...panels]) ?? triggers[0] ?? panels[0];
      if (!root || triggers.length < 2 || panels.length < 2) continue;
      out.push(makeDraft(ctx, {
        kind: "tablist",
        source: "capture-pattern",
        confidence: 0.9,
        root,
        trigger: triggers[0],
        panel: panels[0],
        pairs: pattern.tabs.map((i) => pairOf(ctx.capToNode.get(i.triggerCap), ctx.capToNode.get(i.panelCap))[0]).filter((p): p is InteractionPair => !!p),
        mode: "click",
        preservedDom: true,
        accessibilityNodes: [...triggers, ...panels, root],
        signals: [`${pattern.tabs.length} captured tab/panel pair(s)`, "ARIA tab state was driven during capture"],
      }));
    } else if (pattern.kind === "disclosure") {
      for (const item of pattern.items) {
        const trigger = ctx.capToNode.get(item.triggerCap);
        const panel = ctx.capToNode.get(item.panelCap);
        const root = ctx.capToNode.get(pattern.rootCap) ?? nearestCommonAncestor(ctx, [trigger, panel].filter((n): n is IRNode => !!n)) ?? trigger ?? panel;
        if (!root || !trigger || !panel) continue;
        const mobile = isLikelyMobilePanel(ctx, panel);
        const nav = item.hoverOpen && isInNav(ctx, trigger);
        const kind: InteractionRecipeKind = mobile ? "mobile-menu" : nav ? "nav-menu" : "dropdown-menu";
        out.push(makeDraft(ctx, {
          kind,
          source: "capture-pattern",
          confidence: mobile ? 0.86 : nav ? 0.88 : 0.84,
          root,
          trigger,
          panel,
          pairs: pairOf(trigger, panel),
          mode: item.hoverOpen ? "hover" : "click",
          preservedDom: true,
          accessibilityNodes: [trigger, panel, root],
          signals: [
            "captured trigger/panel disclosure pair",
            item.hoverOpen ? "panel opens on hover" : "panel opens on click",
            item.isDialog ? "source identifies dialog/modal behavior" : "",
            mobile ? "panel matches mobile/fullscreen menu geometry or source naming" : "",
            nav ? "trigger sits in navigation/header context" : "",
          ].filter(Boolean),
        }));
      }
    }
  }
  return out;
}

function fromMountMenus(ctx: Context, interaction: InteractionCapture | undefined): Draft[] {
  const out: Draft[] = [];
  for (const menu of interaction?.menus ?? []) {
    const trigger = ctx.capToNode.get(menu.triggerCap);
    if (!trigger) continue;
    if (isLikelySkipTrigger(trigger, menu.gap)) continue;
    const kind: InteractionRecipeKind = menu.hoverOpen && isInNav(ctx, trigger) ? "nav-menu" : "dropdown-menu";
    out.push(makeDraft(ctx, {
      kind,
      source: "mount-on-open",
      confidence: kind === "nav-menu" ? 0.86 : 0.82,
      root: trigger,
      trigger,
      pairs: [{ triggerCid: trigger.id, triggerText: textContent(trigger, 80) || trigger.attrs["aria-label"] || directText(trigger) }],
      mode: menu.hoverOpen ? "hover" : "click",
      preservedDom: false,
      accessibilityNodes: [trigger],
      signals: [
        "panel is mounted only after interaction and captured as an HTML fragment",
        menu.hoverOpen ? "trigger opened by hover during capture" : "trigger opened by click during capture",
        `captured panel alignment ${menu.align} with ${menu.gap}px gap`,
      ],
    }));
  }
  return out;
}

function fromNativeDetails(ctx: Context): Draft[] {
  const out: Draft[] = [];
  for (const details of ctx.nodes.filter((n) => n.tag === "details")) {
    const children = elementChildren(details);
    const summary = children.find((c) => c.tag === "summary");
    if (!summary) continue;
    const panel = children.find((c) => c !== summary && textContent(c, 80)) ?? details;
    out.push(makeDraft(ctx, {
      kind: "accordion",
      source: "native-details",
      confidence: 0.89,
      root: details,
      trigger: summary,
      panel,
      pairs: pairOf(summary, panel),
      mode: "native",
      preservedDom: true,
      accessibilityNodes: [details, summary, panel],
      signals: ["native details/summary disclosure is present in source DOM", details.attrs.open !== undefined ? "details is open at base" : "details is closed at base"],
    }));
  }
  return out;
}

function fromAriaPairs(ctx: Context): Draft[] {
  const out: Draft[] = [];
  for (const trigger of ctx.nodes) {
    const controls = trigger.attrs["aria-controls"];
    if (!controls || trigger.attrs.role === "tab") continue;
    const panel = ctx.byHtmlId.get(controls);
    if (!panel) continue;
    const hasPopup = trigger.attrs["aria-haspopup"] !== undefined;
    const mobile = isLikelyMobilePanel(ctx, panel);
    const nav = hasPopup && isInNav(ctx, trigger);
    const kind: InteractionRecipeKind = mobile ? "mobile-menu" : hasPopup ? (nav ? "nav-menu" : "dropdown-menu") : "accordion";
    out.push(makeDraft(ctx, {
      kind,
      source: "aria",
      confidence: mobile ? 0.82 : hasPopup ? 0.8 : 0.84,
      root: nearestCommonAncestor(ctx, [trigger, panel]) ?? trigger,
      trigger,
      panel,
      pairs: pairOf(trigger, panel),
      mode: hasPopup ? "click" : "unknown",
      preservedDom: true,
      accessibilityNodes: [trigger, panel],
      signals: [
        "trigger declares aria-controls for a source DOM panel",
        trigger.attrs["aria-expanded"] !== undefined ? "trigger preserves aria-expanded state" : "",
        hasPopup ? `trigger declares aria-haspopup=${trigger.attrs["aria-haspopup"] || "true"}` : "",
      ].filter(Boolean),
    }));
  }
  return out;
}

function fromStructuralMobile(ctx: Context): Draft[] {
  const out: Draft[] = [];
  for (const panel of ctx.nodes) {
    if (!isLikelyMobilePanel(ctx, panel)) continue;
    const trigger = findMobileTrigger(ctx, panel);
    out.push(makeDraft(ctx, {
      kind: "mobile-menu",
      source: "structural",
      confidence: trigger ? 0.78 : 0.72,
      root: panel,
      trigger,
      panel,
      pairs: trigger ? pairOf(trigger, panel) : [{ triggerCid: "", panelCid: panel.id, panelTextSample: textContent(panel, 100) }],
      mode: "click",
      preservedDom: true,
      accessibilityNodes: [trigger, panel],
      signals: [
        "hidden or fullscreen panel matches mobile menu/drawer source naming",
        trigger ? "nearby top-of-page menu trigger was found" : "no reliable trigger found yet",
      ],
    }));
  }
  return out;
}

function fromTablists(ctx: Context): Draft[] {
  const out: Draft[] = [];
  for (const root of ctx.nodes.filter((n) => n.attrs.role === "tablist")) {
    const tabs: IRNode[] = [];
    const walk = (n: IRNode): void => {
      if (n !== root && n.attrs.role === "tablist") return;
      if (n.attrs.role === "tab") tabs.push(n);
      for (const c of elementChildren(n)) walk(c);
    };
    walk(root);
    if (tabs.length < 2) continue;
    const panels = tabs
      .map((t) => t.attrs["aria-controls"] ? ctx.byHtmlId.get(t.attrs["aria-controls"]) : undefined)
      .filter((n): n is IRNode => !!n);
    const pairNodes = panels.length === tabs.length ? tabs.map((t, i) => pairOf(t, panels[i])[0]!) : tabs.map((t) => pairOf(t)[0]!);
    out.push(makeDraft(ctx, {
      kind: "tablist",
      source: "aria",
      confidence: panels.length === tabs.length ? 0.88 : 0.8,
      root,
      trigger: tabs[0],
      panel: panels[0],
      pairs: pairNodes,
      mode: "click",
      preservedDom: true,
      accessibilityNodes: [root, ...tabs, ...panels],
      signals: [`${tabs.length} role=tab trigger(s) inside role=tablist`, panels.length ? "tabs resolve panels through aria-controls" : "panels are not fully resolved yet"],
    }));
  }
  return out;
}

function dedupeAndSort(ctx: Context, drafts: Draft[]): Draft[] {
  const byKey = new Map<string, Draft>();
  for (const d of drafts) {
    const key = [
      d.kind,
      d.triggerCid ?? "",
      d.panelCid ?? "",
      d.rootCid,
      d.source === "capture-pattern" || d.source === "mount-on-open" ? d.source : "structural",
    ].join("|");
    const prev = byKey.get(key);
    if (!prev || d.confidence > prev.confidence || (d.emissionStatus === "semantic-runtime" && prev.emissionStatus !== "semantic-runtime")) {
      byKey.set(key, d);
    }
  }
  const draftsSorted = [...byKey.values()].sort((a, b) => {
    const ab = ctx.byId.get(a.rootCid)?.bboxByVp[ctx.cw];
    const bb = ctx.byId.get(b.rootCid)?.bboxByVp[ctx.cw];
    return (ab?.y ?? 0) - (bb?.y ?? 0)
      || (ab?.x ?? 0) - (bb?.x ?? 0)
      || a.kind.localeCompare(b.kind)
      || b.confidence - a.confidence;
  });
  return draftsSorted;
}

export function buildInteractionRecipeReport(ir: IR, sections: Section[], interaction?: InteractionCapture): InteractionRecipeReport {
  const ctx = buildContext(ir, sections);
  const drafts = dedupeAndSort(ctx, [
    ...fromCapturePatterns(ctx, interaction),
    ...fromMountMenus(ctx, interaction),
    ...fromNativeDetails(ctx),
    ...fromAriaPairs(ctx),
    ...fromStructuralMobile(ctx),
    ...fromTablists(ctx),
  ]);
  const candidates = drafts.map((d, index) => ({ id: `interaction-${String(index + 1).padStart(3, "0")}`, ...d }));
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const c of candidates) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  }
  return {
    version: 1,
    sourceUrl: ir.doc.sourceUrl,
    canonicalViewport: ir.doc.canonicalViewport,
    viewports: ir.doc.viewports,
    summary: {
      totalCandidates: candidates.length,
      highConfidence: candidates.filter((c) => c.confidence >= 0.82).length,
      byKind,
      bySource,
      semanticRuntime: candidates.filter((c) => c.emissionStatus === "semantic-runtime").length,
      reportOnly: candidates.filter((c) => c.emissionStatus === "report-only").length,
      deferred: candidates.filter((c) => c.emissionStatus === "deferred").length,
    },
    candidates,
  };
}

export function interactionRecipeReportToMarkdown(report: InteractionRecipeReport): string {
  const lines: string[] = [];
  lines.push("# Interaction Recipe Report");
  lines.push("");
  lines.push(`Source: ${report.sourceUrl}`);
  lines.push(`Canonical viewport: ${report.canonicalViewport}`);
  lines.push(`Captured viewports: ${report.viewports.join(", ")}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Candidates: ${report.summary.totalCandidates}`);
  lines.push(`- High confidence: ${report.summary.highConfidence}`);
  lines.push(`- Semantic runtime emitted: ${report.summary.semanticRuntime}`);
  lines.push(`- Report-only: ${report.summary.reportOnly}`);
  lines.push(`- By kind: ${Object.entries(report.summary.byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push(`- By source: ${Object.entries(report.summary.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Candidates");
  lines.push("");
  if (!report.candidates.length) lines.push("No interaction recipe candidates were detected.");
  for (const c of report.candidates) {
    lines.push(`### ${c.id}: ${c.kind}`);
    lines.push("");
    lines.push(`- Confidence: ${c.confidence} (${c.risk} risk)`);
    lines.push(`- Source: ${c.source}; mode: ${c.interactionMode}; preserved DOM: ${c.preservedDom ? "yes" : "no"}`);
    lines.push(`- Root: ${c.rootTag} \`${c.rootCid}\`${c.sectionId ? `, ${c.sectionId} (${c.sectionRole ?? "section"})` : ""}`);
    if (c.triggerCid) lines.push(`- Trigger: \`${c.triggerCid}\``);
    if (c.panelCid) lines.push(`- Panel: \`${c.panelCid}\``);
    lines.push(`- Component target: ${c.componentName}`);
    lines.push(`- Counts: ${c.triggerCount} trigger(s), ${c.panelCount} panel(s), ${c.itemCount} item(s)`);
    const acc = [
      c.accessibility.nativeDetails ? "native details" : "",
      c.accessibility.ariaExpanded ? "aria-expanded" : "",
      c.accessibility.ariaControls ? "aria-controls" : "",
      c.accessibility.ariaHaspopup ? "aria-haspopup" : "",
      c.accessibility.roles.length ? `roles ${c.accessibility.roles.join("/")}` : "",
    ].filter(Boolean);
    if (acc.length) lines.push(`- Accessibility: ${acc.join("; ")}`);
    if (c.signals.length) lines.push(`- Signals: ${c.signals.join("; ")}`);
    if (c.sourceHints.length) lines.push(`- Source hints: ${c.sourceHints.slice(0, 12).map((h) => `\`${h}\``).join(", ")}`);
    lines.push(`- Emission: ${c.emissionStatus}; ${c.fallbackReason}`);
    if (c.triggerPanelPairs.length) {
      const sample = c.triggerPanelPairs.slice(0, 4).map((p) => {
        const t = p.triggerText ? ` "${p.triggerText}"` : "";
        const panel = p.panelCid ? ` -> \`${p.panelCid}\`` : "";
        return `\`${p.triggerCid || "unresolved"}\`${t}${panel}`;
      }).join(", ");
      lines.push(`- Pair sample: ${sample}${c.triggerPanelPairs.length > 4 ? ", ..." : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
