import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { collectFileMap, type CloneJobResult } from "@cloner/core";
import { createMcpServer } from "../src/mcp.js";
import { InMemoryStore } from "../src/store.js";
import { InMemoryBackend, type RunJob } from "../src/backends/inMemory.js";

const fakeRunJob: RunJob = async (input) => {
  const base = input.runsDir!;
  const app = join(base, "generated", "app");
  mkdirSync(join(app, "src", "app"), { recursive: true });
  mkdirSync(join(app, "public", "assets", "cloned", "images"), { recursive: true });
  writeFileSync(join(app, "package.json"), '{"name":"cloned-app"}\n');
  writeFileSync(join(app, "src", "app", "page.tsx"), "export default function Page(){return <div/>}\n");
  writeFileSync(join(app, "public", "assets", "cloned", "images", "a.png"), Buffer.from([1, 2, 3, 4]));
  return {
    url: input.url,
    kind: "clone",
    options: input.options ?? {},
    status: "succeeded",
    compilerVersion: "test-0",
    timings: { captureMs: 1, generateMs: 0 },
    files: collectFileMap(base),
    capture: { nodeCount: 9, pollution: false, blocked: false },
    runDir: base,
  } satisfies CloneJobResult;
};

async function connect(backend: InMemoryBackend) {
  const server = createMcpServer(backend, { baseUrl: "http://test" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const parse = (res: unknown): any => JSON.parse((res as { content: { text: string }[] }).content[0]!.text);

test("MCP: list-then-read + bundle contract (never floods context)", async () => {
  const store = new InMemoryStore(60_000);
  const backend = new InMemoryBackend({ store, runJob: fakeRunJob });
  const client = await connect(backend);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["clone_website", "get_clone_status", "get_clone_result", "list_clone_files", "read_clone_files", "get_clone_bundle", "cancel_clone"]) {
      assert.ok(tools.includes(n), `tool ${n} registered`);
    }

    // clone_website → jobId + status only (no files).
    const cw = parse(await client.callTool({ name: "clone_website", arguments: { url: "https://example.com/", options: {} } }));
    assert.ok(cw.jobId);
    assert.equal(cw.status, "queued");
    const jobId = cw.jobId;

    let status = parse(await client.callTool({ name: "get_clone_status", arguments: { jobId } }));
    for (let i = 0; i < 200 && status.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      status = parse(await client.callTool({ name: "get_clone_status", arguments: { jobId } }));
    }
    assert.equal(status.status, "succeeded");

    // status (re-fetch after completion)
    status = parse(await client.callTool({ name: "get_clone_status", arguments: { jobId } }));
    assert.equal(status.status, "succeeded");

    // get_clone_result → metadata only, NO file contents.
    const meta = parse(await client.callTool({ name: "get_clone_result", arguments: { jobId } }));
    assert.equal(meta.fileCount, 3);
    assert.equal(meta.capture.nodeCount, 9);
    assert.ok(!("files" in meta), "result metadata must not include file contents");
    assert.ok(meta.bundleUrl.includes("/bundle"));

    // list_clone_files (glob) → manifest only, no content.
    const list = parse(await client.callTool({ name: "list_clone_files", arguments: { jobId, glob: "**/*.tsx" } }));
    assert.ok(list.files.length >= 1);
    assert.ok(list.files.every((f: any) => f.path.endsWith(".tsx")));
    assert.ok(list.files.some((f: any) => f.path === "src/app/page.tsx"));
    assert.ok(list.files.every((f: any) => !("content" in f)), "list must not include content");

    // read_clone_files → text inline, binary by URL.
    const read = parse(await client.callTool({ name: "read_clone_files", arguments: { jobId, paths: ["src/app/page.tsx", "public/assets/cloned/images/a.png"] } }));
    const page = read.files.find((f: any) => f.path === "src/app/page.tsx");
    assert.equal(page.type, "text");
    assert.ok(page.content.includes("Page"));
    const bin = read.files.find((f: any) => f.path.endsWith("a.png"));
    assert.equal(bin.type, "binary");
    assert.ok(bin.url.startsWith("http://test/"), "binary returned as absolute URL");
    assert.ok(!("content" in bin), "binary must not inline bytes");

    // read size budget → oversized text flagged skipped, not dumped.
    const tiny = parse(await client.callTool({ name: "read_clone_files", arguments: { jobId, paths: ["src/app/page.tsx"], maxBytes: 1 } }));
    assert.equal(tiny.files[0].skipped, true);
    assert.equal(tiny.truncated, true);

    // get_clone_bundle → a download reference, not bytes.
    const bundle = parse(await client.callTool({ name: "get_clone_bundle", arguments: { jobId } }));
    assert.equal(bundle.format, "tgz");
    assert.ok(bundle.bytes > 0);
    assert.ok(/^[0-9a-f]{64}$/.test(bundle.sha256));
    assert.ok(bundle.url.includes(`/v1/clones/${jobId}/bundle`));

    // cancel_clone → purges.
    const cancel = parse(await client.callTool({ name: "cancel_clone", arguments: { jobId } }));
    assert.equal(cancel.cancelled, true);
    const after = parse(await client.callTool({ name: "get_clone_status", arguments: { jobId } }));
    assert.ok(after.error, "status after cancel reports not found");
  } finally {
    store.clear();
  }
});
