import { crawlSite, type CrawlOptions, type CrawlResult } from "./crawl.js";
import { induceTemplates } from "./routeTemplates.js";

export const ION_CLONE_DISCOVERY_VERSION = "ion-clone-discovery-v1" as const;

export type IonCloneDiscoveryRoute = {
  path: string;
  depth: number;
  sources: Array<"entry" | "link" | "sitemap">;
  entryLinks?: Array<{
    label: string;
    sourcePath: string;
    region: "nav" | "header" | "main" | "footer" | "unknown";
  }>;
};

export type IonCloneDiscoveryCluster = {
  pattern: string;
  instances: string[];
  dynamicPositions: number[];
  containerPath: string | null;
  candidateRepresentatives: string[];
};

export type IonCloneDiscoveryV1 = {
  version: typeof ION_CLONE_DISCOVERY_VERSION;
  sourceUrl: string;
  origin: string;
  entryPath: string;
  routes: IonCloneDiscoveryRoute[];
  clusters: IonCloneDiscoveryCluster[];
};

export async function discoverIonCloneInventory(
  opts: CrawlOptions,
): Promise<IonCloneDiscoveryV1> {
  const crawl = await crawlSite(opts);
  return buildIonCloneInventory(crawl);
}

export function buildIonCloneInventory(
  crawl: CrawlResult,
): IonCloneDiscoveryV1 {
  const entryLinked = new Set(
    Object.entries(crawl.linkEvidenceByPath ?? {})
      .filter(([, evidence]) =>
        evidence.some((item) => item.sourcePath === crawl.entryPath),
      )
      .map(([path]) => path),
  );
  const routes = crawl.paths.map((path): IonCloneDiscoveryRoute => {
    const entryLinks = (crawl.linkEvidenceByPath?.[path] ?? []).filter(
      (item) => item.sourcePath === crawl.entryPath,
    );
    return {
      path,
      depth: crawl.depthByPath[path] ?? 0,
      sources: (crawl.sourcesByPath[path] ?? []).filter(
        (source): source is "entry" | "link" | "sitemap" =>
          source === "entry" || source === "link" || source === "sitemap",
      ),
      ...(entryLinks.length ? { entryLinks } : {}),
    };
  });
  const clusters = induceTemplates(crawl.paths).map(
    (template): IonCloneDiscoveryCluster => ({
      pattern: template.template,
      instances: template.instances,
      dynamicPositions: template.dynamicPositions,
      containerPath: template.containerPath,
      candidateRepresentatives: [...template.instances]
        .sort(
          (left, right) =>
            Number(entryLinked.has(right)) - Number(entryLinked.has(left)) ||
            (crawl.depthByPath[left] ?? 0) - (crawl.depthByPath[right] ?? 0) ||
            left.localeCompare(right),
        )
        .slice(0, 5),
    }),
  );
  return {
    version: ION_CLONE_DISCOVERY_VERSION,
    sourceUrl: crawl.entryUrl,
    origin: crawl.origin,
    entryPath: crawl.entryPath,
    routes,
    clusters,
  };
}
