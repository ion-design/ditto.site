import type { CrawlResult } from "../crawl/crawl.js";
import { segmentsOf, toRoutePath } from "../crawl/url.js";
import type { RoutePlan, SelectedRoute } from "../crawl/routeTemplates.js";

export const ION_CLONE_PLAN_VERSION = "ion-clone-plan-v1" as const;

export type IonManifestPlan = {
  key: string;
  entityType: string;
};

export type IonRendererRole = "index" | "listing" | "detail";

export type IonRendererPlan = {
  key: string;
  role: IonRendererRole;
  pattern: string;
  captureUrl?: string;
  manifestKeys: string[];
  reuseRendererKey?: string;
  aliases?: string[];
};

export type IonRouteDispositionPlan = {
  path: string;
  kind: "static" | "renderer" | "passthrough" | "ignored";
  rendererKey?: string;
  reason?: string;
};

export type IonClonePlanV1 = {
  version: typeof ION_CLONE_PLAN_VERSION;
  entryRoute: string;
  staticRoutes: string[];
  manifests: IonManifestPlan[];
  renderers: IonRendererPlan[];
  dispositions: IonRouteDispositionPlan[];
};

export type IonCapturedRenderer = {
  rendererKey: string;
  captureUrl: string;
  routePath: string;
};

export type IonPlannedCloneBundleExtension = {
  version: typeof ION_CLONE_PLAN_VERSION;
  plan: IonClonePlanV1;
  capturedRenderers: IonCapturedRenderer[];
  failedRoutes: Array<{ routePath: string; reason: string }>;
};

const KEY_RE = /^[a-z][a-z0-9-]{0,99}$/;
const PARAM_RE = /^\[[a-z][A-Za-z0-9_]*\]$/;

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
}

function assertKey(value: string, label: string): void {
  if (!KEY_RE.test(value)) throw new Error(`${label} must match ${KEY_RE}`);
}

export function isSafeInternalRoute(value: string): boolean {
  if (value !== "/" && value.endsWith("/")) return false;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  )
    return false;
  if (value.includes("\\") || /%2f|%5c/i.test(value)) return false;
  return segmentsOf(value).every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("[") &&
      !segment.includes("]"),
  );
}

export function isSafeRoutePattern(value: string): boolean {
  if (value === "/") return true;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    return false;
  }
  const params = new Set<string>();
  for (const segment of value.slice(1).split("/")) {
    if (!segment || segment === "." || segment === "..") return false;
    if (segment.includes("[") || segment.includes("]")) {
      if (!PARAM_RE.test(segment) || params.has(segment)) return false;
      params.add(segment);
    }
  }
  return true;
}

export function validateIonClonePlan(input: IonClonePlanV1): IonClonePlanV1 {
  if (
    !input ||
    typeof input !== "object" ||
    input.version !== ION_CLONE_PLAN_VERSION
  ) {
    throw new Error(
      `experimentalClonePlan.version must be "${ION_CLONE_PLAN_VERSION}"`,
    );
  }
  if (!isSafeInternalRoute(input.entryRoute))
    throw new Error(
      "experimentalClonePlan.entryRoute must be a safe internal route",
    );
  if (
    !Array.isArray(input.staticRoutes) ||
    !Array.isArray(input.manifests) ||
    !Array.isArray(input.renderers) ||
    !Array.isArray(input.dispositions)
  ) {
    throw new Error("experimentalClonePlan arrays are required");
  }
  assertUnique(input.staticRoutes, "experimentalClonePlan.staticRoutes");
  for (const route of input.staticRoutes) {
    if (!isSafeInternalRoute(route))
      throw new Error(`unsafe static route: ${route}`);
  }

  const manifestKeys = input.manifests.map((manifest) => manifest.key);
  assertUnique(manifestKeys, "manifest keys");
  for (const manifest of input.manifests) {
    assertKey(manifest.key, "manifest key");
    if (!KEY_RE.test(manifest.entityType))
      throw new Error(`manifest ${manifest.key} has an invalid entityType`);
  }

  const rendererKeys = input.renderers.map((renderer) => renderer.key);
  assertUnique(rendererKeys, "renderer keys");
  const rendererByKey = new Map(
    input.renderers.map((renderer) => [renderer.key, renderer]),
  );
  for (const renderer of input.renderers) {
    assertKey(renderer.key, "renderer key");
    if (!["index", "listing", "detail"].includes(renderer.role))
      throw new Error(`renderer ${renderer.key} has an invalid role`);
    if (!isSafeRoutePattern(renderer.pattern))
      throw new Error(`renderer ${renderer.key} has an unsafe pattern`);
    if (!!renderer.captureUrl === !!renderer.reuseRendererKey) {
      throw new Error(
        `renderer ${renderer.key} must define exactly one of captureUrl or reuseRendererKey`,
      );
    }
    if (renderer.captureUrl && !isSafeInternalRoute(renderer.captureUrl)) {
      throw new Error(`renderer ${renderer.key} has an unsafe captureUrl`);
    }
    assertUnique(
      renderer.manifestKeys,
      `renderer ${renderer.key} manifestKeys`,
    );
    if (renderer.manifestKeys.length === 0) {
      throw new Error(
        `renderer ${renderer.key} requires at least one manifestKey`,
      );
    }
    for (const key of renderer.manifestKeys) {
      if (!manifestKeys.includes(key))
        throw new Error(
          `renderer ${renderer.key} references unknown manifest ${key}`,
        );
    }
    for (const alias of renderer.aliases ?? []) {
      if (!isSafeRoutePattern(alias))
        throw new Error(`renderer ${renderer.key} has an unsafe alias`);
    }
    if (
      renderer.reuseRendererKey &&
      !rendererByKey.has(renderer.reuseRendererKey)
    ) {
      throw new Error(
        `renderer ${renderer.key} reuses unknown renderer ${renderer.reuseRendererKey}`,
      );
    }
  }
  const referencedManifestKeys = new Set(
    input.renderers.flatMap((renderer) => renderer.manifestKeys),
  );
  for (const key of manifestKeys) {
    if (!referencedManifestKeys.has(key))
      throw new Error(`manifest ${key} is not referenced by a renderer`);
  }

  const resolveRoot = (key: string, stack: string[] = []): IonRendererPlan => {
    if (stack.includes(key))
      throw new Error(`renderer reuse cycle: ${[...stack, key].join(" -> ")}`);
    const renderer = rendererByKey.get(key);
    if (!renderer) throw new Error(`unknown renderer ${key}`);
    return renderer.reuseRendererKey
      ? resolveRoot(renderer.reuseRendererKey, [...stack, key])
      : renderer;
  };
  for (const key of rendererKeys) resolveRoot(key);

  assertUnique(
    input.dispositions.map((item) => item.path),
    "route disposition paths",
  );
  for (const item of input.dispositions) {
    if (!isSafeInternalRoute(item.path))
      throw new Error(`unsafe disposition path: ${item.path}`);
    if (item.kind === "renderer") {
      if (!item.rendererKey || !rendererByKey.has(item.rendererKey)) {
        throw new Error(
          `renderer disposition ${item.path} requires a known rendererKey`,
        );
      }
    } else if (item.rendererKey) {
      throw new Error(
        `${item.kind} disposition ${item.path} cannot define rendererKey`,
      );
    }
    if (
      (item.kind === "passthrough" || item.kind === "ignored") &&
      !item.reason?.trim()
    ) {
      throw new Error(
        `${item.kind} disposition ${item.path} requires a reason`,
      );
    }
  }
  return input;
}

function routeDepth(path: string): number {
  return segmentsOf(path).length;
}

/**
 * Ion has already performed the live crawl before it authors an explicit clone
 * plan. Reconstruct the bounded crawl surface needed by the compiler from that
 * validated plan so the planned expansion does not crawl the same site again.
 *
 * Every non-entry path is treated as directly supplied discovery evidence. The
 * handoff extraction scope is intentionally entry-link-like (depth 1): a plan is
 * the authoritative inventory and all of its dispositions must remain visible in
 * the generated bundle, including nested commerce and article routes.
 */
export function buildIonPlannedCrawlResult(
  sourceUrl: string,
  input: IonClonePlanV1,
): CrawlResult {
  const plan = validateIonClonePlan(input);
  const entryPath = toRoutePath(sourceUrl, sourceUrl) ?? "/";
  if (plan.entryRoute !== entryPath) {
    throw new Error(
      `experimentalClonePlan.entryRoute must match source entry route ${entryPath}`,
    );
  }

  const paths = [
    ...new Set([
      plan.entryRoute,
      ...plan.staticRoutes,
      ...plan.renderers.flatMap((renderer) =>
        renderer.captureUrl ? [renderer.captureUrl] : [],
      ),
      ...plan.dispositions.map((disposition) => disposition.path),
    ]),
  ].sort();
  const depthByPath = Object.fromEntries(
    paths.map((path) => [path, path === entryPath ? 0 : 1]),
  );
  const sourcesByPath = Object.fromEntries(
    paths.map((path) => [
      path,
      path === entryPath ? ["entry"] : ["link"],
    ]),
  );

  return {
    entryUrl: sourceUrl,
    entryPath,
    origin: new URL(sourceUrl).origin,
    paths,
    depthByPath,
    sourcesByPath,
    linkEvidenceByPath: {},
    robotsDisallow: [],
  };
}

export async function resolveCloneCrawl(params: {
  sourceUrl: string;
  experimentalClonePlan?: IonClonePlanV1;
  liveCrawl: () => Promise<CrawlResult>;
}): Promise<CrawlResult> {
  return params.experimentalClonePlan
    ? buildIonPlannedCrawlResult(
        params.sourceUrl,
        params.experimentalClonePlan,
      )
    : params.liveCrawl();
}

export function buildIonPlannedRoutePlan(
  input: IonClonePlanV1,
  crawl: CrawlResult,
  inferredPlan: RoutePlan,
): { routePlan: RoutePlan; capturedRenderers: IonCapturedRenderer[] } {
  const plan = validateIonClonePlan(input);
  if (plan.entryRoute !== crawl.entryPath) {
    throw new Error(
      `experimentalClonePlan.entryRoute must match discovered entry route ${crawl.entryPath}`,
    );
  }
  const discovered = new Set(crawl.paths);
  const rendererByKey = new Map(
    plan.renderers.map((renderer) => [renderer.key, renderer]),
  );
  const resolveRoot = (renderer: IonRendererPlan): IonRendererPlan =>
    renderer.reuseRendererKey
      ? resolveRoot(rendererByKey.get(renderer.reuseRendererKey)!)
      : renderer;

  const capturedRenderers: IonCapturedRenderer[] = [];
  const seenRoots = new Set<string>();
  for (const renderer of plan.renderers) {
    const root = resolveRoot(renderer);
    if (seenRoots.has(root.key)) continue;
    seenRoots.add(root.key);
    const captureUrl = root.captureUrl!;
    if (!discovered.has(captureUrl)) {
      throw new Error(
        `renderer ${root.key} captureUrl was not discovered: ${captureUrl}`,
      );
    }
    capturedRenderers.push({
      rendererKey: root.key,
      captureUrl,
      routePath: captureUrl,
    });
  }

  const selected: SelectedRoute[] = [];
  const seen = new Set<string>();
  const add = (
    path: string,
    role: SelectedRoute["role"],
    template: string,
  ): void => {
    if (seen.has(path)) return;
    if (!discovered.has(path))
      throw new Error(`planned capture route was not discovered: ${path}`);
    seen.add(path);
    selected.push({
      path,
      role: path === plan.entryRoute ? "entry" : role,
      template,
      depth: routeDepth(path),
    });
  };
  add(plan.entryRoute, "entry", "/");
  for (const route of plan.staticRoutes) add(route, "page", route);
  for (const renderer of capturedRenderers) {
    const source = rendererByKey.get(renderer.rendererKey)!;
    add(
      renderer.captureUrl,
      source.role === "index" ? "listing" : "representative",
      source.pattern,
    );
  }

  return {
    routePlan: {
      entry: plan.entryRoute,
      maxRoutes: selected.length,
      selected,
      collections: inferredPlan.collections,
      templates: inferredPlan.templates,
      skipped: inferredPlan.skipped,
    },
    capturedRenderers,
  };
}
