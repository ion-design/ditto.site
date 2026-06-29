import { join } from "node:path";
import { writeText } from "../util/fsx.js";
import type { SeoRouteSummary } from "./seo.js";

export type GeneratedDocsInput = {
  sourceUrl: string;
  routes: SeoRouteSummary[];
  styling: "tailwind" | "css";
  framework: "next" | "vite";
  multiRoute: boolean;
  components: boolean;
  sectionCount: number;
  componentCount: number;
  svgCount: number;
  hasContentModule: boolean;
  runtimeUtilities: string[];
};

function routeLine(route: SeoRouteSummary): string {
  return `- ${route.href} - ${route.title || route.routePath}`;
}

function runtimeLine(runtimeUtilities: string[]): string {
  return runtimeUtilities.length ? runtimeUtilities.sort().join(", ") : "none emitted for this capture";
}

export function agentsMd(input: GeneratedDocsInput): string {
  const routes = input.routes.length ? input.routes.map(routeLine).join("\n") : "- / - generated route";
  const root = input.framework === "next" ? "src/app" : "src";
  const routeBody = input.framework === "next" ? "`src/app/page.tsx` and nested route `page.tsx` files" : input.multiRoute ? "`src/routes/*/page.tsx` route modules" : "`src/page.tsx`";
  const seoFiles = input.framework === "next"
    ? "`src/app/robots.ts`, `src/app/sitemap.ts`, and `src/app/llms.txt/route.ts`"
    : "`public/robots.txt`, `public/sitemap.xml`, and `public/llms.txt`";
  return `# AGENTS.md

This is a generated ditto.site clone app for ${input.sourceUrl}. It is a static ${input.framework === "next" ? "Next.js App Router" : "Vite React"} project produced from captured DOM, CSS, assets, metadata, and interaction recipes.

## Run

- \`npm install\`
- \`npm run dev\`
- \`npm run build\`
- \`npm run start\`

## Safe Edit Areas

- \`${root}/content.ts\` or \`${root}/content.tsx\`: editable structured content extracted from repeated components and sections when present.
- \`${root}/components/\`: generated component modules. Edit copy, links, and simple JSX structure with care.
- \`${root}/sections/\`: generated section modules for single-page section splits when present.
- \`${root}/svgs/\`: hoisted inline SVG modules. Edit only when intentionally changing artwork.
- \`${root}/ditto.css\`: fidelity CSS for captured layout, pseudos, keyframes, and interaction states. Small visual tweaks are reasonable; broad rewrites can break clone fidelity.
- Root SEO/docs files such as \`AGENTS.md\`, \`ARCHITECTURE.md\`, and ${seoFiles}.

## Generated Runtime

\`${root}/ditto\` contains generated runtime utilities for captured interactions and motion. Current runtime utilities: ${runtimeLine(input.runtimeUtilities)}. Do not casually rewrite these files; they are plumbing that maps captured recipes to stable \`data-ditto-id\` anchors in delivered apps.

## File Meanings

- ${routeBody}: generated route bodies.
- \`${root}/content.ts\`: structured data extracted from repeated clone regions.
- \`${root}/components/\`: reusable JSX components promoted from repeated captured subtrees.
- \`${root}/sections/\`: page sections split from the captured body.
- \`${root}/svgs/\`: inline SVGs hoisted out of page/section files.
- \`${root}/ditto.css\`: generated CSS that preserves source layout and visual details not represented by Tailwind utilities.
- \`${root}/ditto-meta.ts\`: delivered-app metadata for anchors that still need runtime or stylesheet targeting after validation-only ids are stripped.

## Routes

${routes}

## Do Not Edit Casually

- \`${root}/ditto/\` runtime utilities.
- Generated anchor metadata such as \`ditto-meta.ts\`.
- Validation-only files in working captures, including \`_cids.ts\` and \`_styles.ts\` before export stripping.
- Framework shell plumbing unless you are intentionally changing global metadata or page mounting behavior.
`;
}

export function architectureMd(input: GeneratedDocsInput): string {
  const routes = input.routes.length ? input.routes.map(routeLine).join("\n") : "- / - generated route";
  const root = input.framework === "next" ? "src/app" : "src";
  return `# ARCHITECTURE.md

## Overview

This app is a generated ditto.site clone. The generator captured the source page${input.multiRoute ? "s" : ""}, normalized the rendered DOM into an IR, inferred assets/tokens/sections/recipes, and emitted a static ${input.framework === "next" ? "Next.js App Router" : "Vite React"} project.

## Structure

- ${input.framework === "next" ? "`src/app/layout.tsx`: root App Router layout, language, metadata, viewport, JSON-LD, and shared shell." : "`index.html` and route HTML files: Vite HTML entries with captured language, metadata, JSON-LD, and body attributes."}
- ${input.framework === "next" ? "`src/app/page.tsx` and nested route `page.tsx` files" : input.multiRoute ? "`src/routes/*/page.tsx` files" : "`src/page.tsx`"}: generated route bodies.
- \`${root}/globals.css\`: reset, font faces, design tokens, and global page base.
- \`${root}/ditto.css\`: route or page fidelity CSS.
- \`${root}/content.ts\`: editable data layer when repeated regions were promoted.
- \`${root}/components/\`, \`${root}/sections/\`, \`${root}/svgs/\`: generated JSX modules.
- \`${root}/ditto/\`: runtime helpers for interaction and motion recipes.
- \`public/assets/cloned/\`: materialized source assets.

## Styling

The generator uses ${input.styling === "tailwind" ? "Tailwind classes for declarations that can be represented as stable utilities" : "CSS classes for generated visual declarations"}. Some styles remain in \`ditto.css\` because they are route-scoped, pseudo-element based, keyframe based, interaction-state based, or too specific to translate safely without changing the rendered result.

## Anchors

\`data-ditto-id\` exists in delivered apps where runtime utilities or generated CSS still need a stable DOM anchor. Validation-only capture ids are stripped from production output and should not be reintroduced.

## Recipes And Runtime

Recipes identify higher-level patterns such as repeated cards, logo clouds, navigation, disclosures, accordions, tabs, carousels, and motion. Sections and components provide editable structure, SVG modules preserve source artwork, and \`${root}/ditto\` applies the small runtime behaviors that were captured safely. Runtime utilities emitted for this clone: ${runtimeLine(input.runtimeUtilities)}.

## Clone Metadata

- routes: ${input.routes.length}
- extracted components: ${input.componentCount}
- section modules: ${input.sectionCount}
- SVG modules: ${input.svgCount}
- content module: ${input.hasContentModule ? "yes" : "no"}
- component extraction requested: ${input.components ? "yes" : "no"}

## Routes

${routes}

## Tradeoffs

The clone prioritizes deterministic static fidelity, accessible markup, local asset materialization, and source metadata preservation. It may keep measured CSS where inferred layout intent is uncertain. It intentionally defers arbitrary JavaScript replay, video-like animation replay, and full third-party application behavior. External services, live personalization, analytics, payments, auth, and complex client app state are not reconstructed unless a specific safe recipe exists.
`;
}

export function emitGeneratedDocs(appDir: string, input: GeneratedDocsInput): void {
  writeText(join(appDir, "AGENTS.md"), agentsMd(input));
  writeText(join(appDir, "ARCHITECTURE.md"), architectureMd(input));
}
