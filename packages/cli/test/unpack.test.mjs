import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BIN = fileURLToPath(new URL("../bin/ditto.mjs", import.meta.url));

function sha256(s) {
  return createHash("sha256").update(Buffer.from(s)).digest("hex");
}

/** Run the CLI. `stdin` (optional) is written to the child's stdin. */
function run(args, { stdin, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolvePromise({ code, out, err }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ditto-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("unpack: writes a text file tree from a result envelope", async () => {
  await withTmp(async (dir) => {
    const content = "export default function Page() { return null; }\n";
    const doc = {
      jobId: "job_1",
      files: {
        "package.json": { type: "text", content: '{"name":"x"}\n', bytes: 13, sha256: sha256('{"name":"x"}\n') },
        "src/app/page.tsx": { type: "text", content, bytes: content.length, sha256: sha256(content) },
      },
    };
    const jsonPath = join(dir, "clone.json");
    const out = join(dir, "out");
    await writeFile(jsonPath, JSON.stringify(doc));

    const res = await run(["unpack", jsonPath, out]);
    assert.equal(res.code, 0, res.err);
    assert.equal(await readFile(join(out, "package.json"), "utf8"), '{"name":"x"}\n');
    assert.equal(await readFile(join(out, "src/app/page.tsx"), "utf8"), content);
    assert.match(res.out, /Wrote 2 files/);
  });
});

test("unpack: reads JSON from stdin with '-'", async () => {
  await withTmp(async (dir) => {
    const doc = { files: { "a.txt": { type: "text", content: "hi" } } };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out], { stdin: JSON.stringify(doc) });
    assert.equal(res.code, 0, res.err);
    assert.equal(await readFile(join(out, "a.txt"), "utf8"), "hi");
  });
});

test("unpack: materializes inline base64 binary assets", async () => {
  await withTmp(async (dir) => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const doc = {
      files: {
        "public/logo.png": {
          type: "binary",
          content: bytes.toString("base64"),
          encoding: "base64",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out], { stdin: JSON.stringify(doc) });
    assert.equal(res.code, 0, res.err);
    const written = await readFile(join(out, "public/logo.png"));
    assert.deepEqual([...written], [...bytes]);
  });
});

test("unpack: fetches binary assets by URL and resolves relative URLs against base", async () => {
  await withTmp(async (dir) => {
    const asset = Buffer.from("PNGDATA");
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/v1/clones/job_1/files/public/img.png" && req.headers.authorization === "Bearer k") {
        res.writeHead(200);
        res.end(asset);
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      const doc = {
        files: {
          "public/img.png": {
            type: "binary",
            url: "/v1/clones/job_1/files/public/img.png",
            bytes: asset.length,
            sha256: createHash("sha256").update(asset).digest("hex"),
          },
        },
      };
      const out = join(dir, "out");
      const res = await run(["unpack", "-", out], {
        stdin: JSON.stringify(doc),
        env: { DITTO_API_URL: `http://127.0.0.1:${port}`, DITTO_API_KEY: "k" },
      });
      assert.equal(res.code, 0, res.err);
      assert.deepEqual([...(await readFile(join(out, "public/img.png")))], [...asset]);
    } finally {
      server.close();
    }
  });
});

test("unpack: --no-fetch skips remote binaries but still writes text", async () => {
  await withTmp(async (dir) => {
    const doc = {
      files: {
        "index.html": { type: "text", content: "<h1>hi</h1>" },
        "public/img.png": { type: "binary", url: "/v1/clones/x/files/public/img.png" },
      },
    };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out, "--no-fetch"], { stdin: JSON.stringify(doc) });
    assert.equal(res.code, 0, res.err);
    assert.equal(await readFile(join(out, "index.html"), "utf8"), "<h1>hi</h1>");
    await assert.rejects(stat(join(out, "public/img.png")));
    assert.match(res.err, /skipped/);
  });
});

test("unpack: refuses path traversal", async () => {
  await withTmp(async (dir) => {
    const doc = { files: { "../escape.txt": { type: "text", content: "x" } } };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out], { stdin: JSON.stringify(doc) });
    assert.notEqual(res.code, 0);
    assert.match(res.err, /outside output dir/);
  });
});

test("unpack: fails clearly on a queued job with no files", async () => {
  await withTmp(async (dir) => {
    const doc = { jobId: "job_9", status: "queued" };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out], { stdin: JSON.stringify(doc) });
    assert.notEqual(res.code, 0);
    assert.match(res.err, /queued job/);
  });
});

test("unpack: reports sha256 mismatch as a failure", async () => {
  await withTmp(async (dir) => {
    const doc = { files: { "a.txt": { type: "text", content: "hi", sha256: "deadbeef" } } };
    const out = join(dir, "out");
    const res = await run(["unpack", "-", out], { stdin: JSON.stringify(doc) });
    assert.notEqual(res.code, 0);
    assert.match(res.err, /integrity check/);
    await assert.rejects(stat(join(out, "a.txt")));
  });
});

test("help: exits 0 and prints usage", async () => {
  const res = await run(["--help"]);
  assert.equal(res.code, 0);
  assert.match(res.out, /ditto unpack/);
});
