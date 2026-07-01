import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeCloneRequestOptions } from "@cloner/core";
import type { Backend } from "./backend.js";
import { filterMetas, metaOf, paginate, readFiles } from "./files.js";

const optionsShape = {
  mode: z.enum(["single", "multi"]).optional(),
  styling: z.enum(["tailwind", "css"]).optional(),
  framework: z.enum(["next", "vite"]).optional(),
  verify: z.boolean().optional(),
  asyncVerify: z.boolean().optional(),
  maxRoutes: z.number().int().positive().optional(),
  maxCollection: z.number().int().positive().optional(),
  captureConcurrency: z.number().int().positive().optional(),
  validationConcurrency: z.number().int().positive().optional(),
  viewportConcurrency: z.number().int().positive().optional(),
  multiPage: z.boolean().optional(),
  humanizeMode: z.enum(["tailwind", "css"]).optional(),
  viewports: z.array(z.number().int().positive()).optional(),
  interactions: z.boolean().optional(),
  components: z.boolean().optional(),
  motion: z.boolean().optional(),
  noCache: z.boolean().optional(),
};

const json = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * MCP server exposing the same service functions as the REST API. The key
 * principle: never flood the agent's context. Tools return references +
 * manifests; the agent pulls only the files it needs (list-then-read), and
 * binaries/bundles are always URLs, never bytes.
 */
export function createMcpServer(backend: Backend, opts?: { baseUrl?: string }): McpServer {
  const baseUrl = opts?.baseUrl ?? "";
  const abs = (u: string) => (u.startsWith("/") && baseUrl ? baseUrl + u : u);
  const server = new McpServer({ name: "ditto.site", version: "0.1.0" });

  // clone_website → start a job; returns immediately, never blocks.
  server.registerTool(
    "clone_website",
    {
      description: "Clone a website by URL. Returns { jobId, status } immediately — poll get_clone_status, then browse with list_clone_files / read_clone_files. Never returns file contents.",
      inputSchema: { url: z.string().url(), options: z.object(optionsShape).optional() },
    },
    async ({ url, options }) => {
      if (!/^https?:\/\//i.test(url)) return json({ error: "url must be http(s)" }, true);
      const out = await backend.submit(url, normalizeCloneRequestOptions(options ?? {}));
      return json({ jobId: out.jobId, status: out.status });
    },
  );

  server.registerTool(
    "get_clone_status",
    { description: "Poll a clone job's status.", inputSchema: { jobId: z.string() } },
    async ({ jobId }) => {
      const v = await backend.status(jobId);
      if (!v) return json({ error: "not found", jobId }, true);
      return json({ jobId, status: v.status, timings: v.timings, capture: v.capture, error: v.error });
    },
  );

  // get_clone_result → METADATA ONLY (no file contents): the cheap overview.
  server.registerTool(
    "get_clone_result",
    { description: "Get a clone's result metadata (status, timings, routes, verify summary, capture sanity, fileCount, totalBytes, bundleUrl) — NO file contents.", inputSchema: { jobId: z.string() } },
    async ({ jobId }) => {
      const v = await backend.status(jobId);
      if (!v) return json({ error: "not found", jobId }, true);
      if (v.status !== "succeeded" && v.status !== "cached") return json({ jobId, status: v.status, error: v.error });
      return json({
        jobId,
        status: v.status,
        url: v.url,
        kind: v.kind,
        timings: v.timings,
        routes: v.routes,
        capture: v.capture,
        verify: v.verify,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        bundleUrl: abs(`/v1/clones/${jobId}/bundle?format=tgz`),
      });
    },
  );

  // list_clone_files → the manifest (paths only, no content), filterable + paginated.
  server.registerTool(
    "list_clone_files",
    {
      description: "List a clone's files as a manifest [{ path, type, bytes, sha256 }] with NO content. Filter by glob (e.g. \"**/*.tsx\") or route; paginated via cursor.",
      inputSchema: { jobId: z.string(), glob: z.string().optional(), route: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ jobId, glob, route, cursor, limit }) => {
      const facets = await backend.facets(jobId);
      if (!facets) return json({ error: "not found or not ready", jobId }, true);
      const metas = filterMetas(metaOf(facets), { glob, route }).sort((a, b) => (a.path < b.path ? -1 : 1));
      const page = paginate(metas, cursor, limit ?? 200);
      return json({ jobId, files: page.items, nextCursor: page.nextCursor, total: metas.length });
    },
  );

  // read_clone_files → contents for SPECIFIC files (text inline, binaries as URLs),
  // with a per-call size budget so a careless request can't blow the window.
  server.registerTool(
    "read_clone_files",
    {
      description: "Read specific files by exact path. Text inline; binaries as URLs (never bytes). Enforces a per-call size budget (default 256KB); oversized text is flagged skipped.",
      inputSchema: { jobId: z.string(), paths: z.array(z.string()).min(1), maxBytes: z.number().int().positive().optional() },
    },
    async ({ jobId, paths, maxBytes }) => {
      const facets = await backend.facets(jobId);
      if (!facets) return json({ error: "not found or not ready", jobId }, true);
      const res = await readFiles(facets, paths, { maxBytes, resolveUrl: abs });
      return json({ jobId, ...res });
    },
  );

  // get_clone_bundle → a DOWNLOAD REFERENCE to the whole app (URL, not bytes).
  server.registerTool(
    "get_clone_bundle",
    { description: "Get a download reference to the whole clone as one compressed archive: { url, format, bytes, sha256 } — a URL, not the bytes. Fetch it out-of-band and expand to a runnable generated app.", inputSchema: { jobId: z.string(), format: z.enum(["tgz", "zip"]).optional() } },
    async ({ jobId, format }) => {
      const b = await backend.bundle(jobId, format ?? "tgz");
      if (!b) return json({ error: "not found or not ready", jobId }, true);
      const url = b.url ?? abs(`/v1/clones/${jobId}/bundle?format=${b.format}`);
      return json({ jobId, url, format: b.format, bytes: b.bytes.length, sha256: b.sha256 });
    },
  );

  server.registerTool(
    "list_clones",
    { description: "List recent clone jobs (metadata only).", inputSchema: {} },
    async () => {
      const clones = await backend.list();
      return json({ clones: clones.map((c) => ({ jobId: c.jobId, url: c.url, kind: c.kind, status: c.status })) });
    },
  );

  server.registerTool(
    "cancel_clone",
    { description: "Cancel/purge a clone job and its artifacts.", inputSchema: { jobId: z.string() } },
    async ({ jobId }) => {
      const ok = await backend.remove(jobId);
      return json({ jobId, cancelled: ok });
    },
  );

  return server;
}
