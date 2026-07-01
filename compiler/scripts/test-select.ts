// Dev-only: replay selectRoutes on a site's discovered crawl paths (from crawl.json) to
// inspect/verify the route plan WITHOUT re-capturing. Usage: tsx scripts/test-select.ts [maxRoutes]
import { selectRoutes } from "../src/crawl/routeTemplates.js";
import { readFileSync } from "node:fs";

const sites: [string, string][] = [
  ["cropin", "output/cropin"],
];
const maxRoutes = Number(process.argv[2] ?? 25);
for (const [site, dir] of sites) {
  let c: { entryPath?: string; depthByPath?: Record<string, number> };
  try { c = JSON.parse(readFileSync(`${dir}/.clone/crawl.json`, "utf8")); } catch { console.log(`\n### ${site} (no crawl.json)`); continue; }
  const paths = Object.keys(c.depthByPath ?? {});
  const plan = selectRoutes({ entryPath: c.entryPath ?? "/", paths, maxRoutes });
  console.log(`\n### ${site}  (discovered ${paths.length}, maxRoutes ${maxRoutes}) ###`);
  console.log("  collections:", plan.collections.map((x) => `${x.template}(${x.instanceCount})`).join("  ") || "none");
  console.log("  selected:");
  for (const r of plan.selected) console.log(`    ${r.role.padEnd(14)} ${r.path}`);
}
