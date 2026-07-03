#!/usr/bin/env node
// ditto — official command-line helper for ditto.site.
//
// `ditto unpack <clone.json> <out-dir>` turns the JSON returned by
// `POST /v1/clones` (or `GET /v1/clones/:id/result`) into a real project tree
// on disk: text files are written from their inline `content`, and binary
// assets are materialized from inline base64 or fetched from their reference
// URL. Zero dependencies — just Node >= 20.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const USAGE = `ditto — unpack a ditto.site clone result into a project tree

Usage:
  ditto unpack <clone.json|-> <out-dir> [options]

Arguments:
  <clone.json>   Path to the saved JSON (POST /v1/clones or GET .../result),
                 or "-" to read the JSON from stdin (e.g. piped from curl).
  <out-dir>      Directory to write the project into (created if missing).

Options:
  --base-url <url>   Base URL used to resolve relative binary asset URLs.
                     Defaults to $DITTO_API_URL.
  --api-key <key>    Bearer key sent when fetching binary assets.
                     Defaults to $DITTO_API_KEY.
  --no-fetch         Do not fetch binary assets over the network; report them
                     as skipped instead. Text files are still written.
  --quiet            Only print the final summary line.
  -h, --help         Show this help.

Examples:
  npm run unpack -- clone.json ./out

  curl -sS -X POST "$DITTO_API_URL/v1/clones" \\
    -H "authorization: Bearer $DITTO_API_KEY" \\
    -H "content-type: application/json" \\
    -d '{"url":"https://example.com/","options":{"mode":"single"}}' \\
    | npm run --silent unpack -- - ./out

`;

/** Print to stderr and exit non-zero. */
function fail(msg) {
  process.stderr.write(`ditto: ${msg}\n`);
  process.exit(1);
}

/** Minimal flag parser: pulls known --flags out, returns { positionals, flags }. */
function parseArgs(argv) {
  const positionals = [];
  const flags = { fetch: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--no-fetch":
        flags.fetch = false;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "--base-url":
        flags.baseUrl = argv[++i];
        break;
      case "--api-key":
        flags.apiKey = argv[++i];
        break;
      default:
        if (a.startsWith("--")) fail(`unknown option: ${a}`);
        positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Read the whole of stdin as a string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Accept either the full result envelope ({ files: {...} }) or a bare file map. */
function extractFiles(doc) {
  if (doc && typeof doc === "object" && doc.files && typeof doc.files === "object") {
    return doc.files;
  }
  // A bare file map: values look like clone file entries.
  if (doc && typeof doc === "object") {
    const vals = Object.values(doc);
    if (vals.length && vals.every((v) => v && typeof v === "object" && ("content" in v || "url" in v || "type" in v))) {
      return doc;
    }
  }
  return null;
}

/** Resolve `path` under `outDir`, refusing anything that escapes the tree
 *  (absolute paths, `..`, leading slashes) — clone results are untrusted input. */
function safeJoin(outDir, path) {
  const cleaned = String(path).replace(/^[/\\]+/, "");
  const dest = resolve(outDir, cleaned);
  const rel = relative(outDir, dest);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`refusing to write outside output dir: ${path}`);
  }
  return dest;
}

/** Decode a binary entry's inline bytes, if present (base64 or plain). */
function inlineBytes(entry) {
  if (typeof entry.base64 === "string") return Buffer.from(entry.base64, "base64");
  if (typeof entry.content === "string") {
    const enc = entry.encoding || (entry.type === "binary" ? "base64" : "utf8");
    return Buffer.from(entry.content, enc === "base64" ? "base64" : "utf8");
  }
  return null;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchBinary(url, baseUrl, apiKey) {
  const abs = /^https?:\/\//i.test(url) ? url : baseUrl ? new URL(url, baseUrl).toString() : null;
  if (!abs) throw new Error("relative asset URL but no --base-url / $DITTO_API_URL set");
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(abs, { headers });
  if (!res.ok) throw new Error(`GET ${abs} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function unpack(positionals, flags) {
  const [input, outDir] = positionals;
  if (!input || !outDir) fail("unpack needs <clone.json|-> and <out-dir>\n\n" + USAGE);

  const raw = input === "-" ? await readStdin() : await readFile(input, "utf8").catch((e) => fail(`cannot read ${input}: ${e.message}`));
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    fail(`input is not valid JSON: ${e.message}`);
  }

  if (doc && (doc.status === "queued" || doc.jobId) && !doc.files) {
    fail(
      `this looks like a queued job (${doc.jobId ? `jobId ${doc.jobId}` : doc.status}), not a finished result.\n` +
        `Poll GET /v1/clones/<id>/result until it has a "files" map, then unpack that.`,
    );
  }

  const files = extractFiles(doc);
  if (!files) fail(`no "files" map found in the input — is this a clone result JSON?`);

  const outAbs = resolve(outDir);
  const baseUrl = flags.baseUrl || process.env.DITTO_API_URL || "";
  const apiKey = flags.apiKey || process.env.DITTO_API_KEY || "";
  const log = (m) => {
    if (!flags.quiet) process.stderr.write(m + "\n");
  };

  let written = 0;
  let bytes = 0;
  const skipped = [];

  for (const [path, entry] of Object.entries(files)) {
    if (!entry || typeof entry !== "object") {
      skipped.push({ path, reason: "malformed entry" });
      continue;
    }
    const isBinary = entry.type === "binary" || entry.kind === "binary";
    let buf;

    if (isBinary) {
      buf = inlineBytes(entry);
      if (!buf) {
        if (!flags.fetch) {
          skipped.push({ path, reason: "binary asset (fetch disabled)" });
          continue;
        }
        if (typeof entry.url !== "string") {
          skipped.push({ path, reason: "binary asset with no inline bytes or url" });
          continue;
        }
        try {
          buf = await fetchBinary(entry.url, baseUrl, apiKey);
        } catch (e) {
          skipped.push({ path, reason: `could not fetch asset: ${e.message}` });
          continue;
        }
      }
    } else {
      buf = Buffer.from(typeof entry.content === "string" ? entry.content : "", "utf8");
    }

    if (typeof entry.sha256 === "string" && entry.sha256 && sha256(buf) !== entry.sha256) {
      log(`  ! ${path}: sha256 mismatch`);
      fail(`${path} failed sha256 integrity check`);
    }

    const dest = safeJoin(outAbs, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    written++;
    bytes += buf.length;
    log(`  + ${path}`);
  }

  const kb = (bytes / 1024).toFixed(1);
  log("");
  process.stdout.write(`Wrote ${written} file${written === 1 ? "" : "s"} (${kb} KB) to ${relative(process.cwd(), outAbs) || "."}\n`);

  if (skipped.length) {
    process.stderr.write(`\n${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped:\n`);
    for (const s of skipped) process.stderr.write(`  - ${s.path}: ${s.reason}\n`);
    const anyAsset = skipped.some((s) => /asset|binary/.test(s.reason));
    if (anyAsset) {
      process.stderr.write(
        `\nTip: binary assets are referenced by URL. Set $DITTO_API_URL (and $DITTO_API_KEY if\n` +
          `the API is authenticated) so ditto can fetch them, or download the whole app in one\n` +
          `shot with GET /v1/clones/<id>/bundle?format=tgz.\n`,
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift();

  if (flags.help || !command) {
    process.stdout.write(USAGE);
    // No command at all is a misuse (exit 1); an explicit --help is success.
    process.exit(flags.help ? 0 : 1);
  }

  switch (command) {
    case "unpack":
      await unpack(positionals, flags);
      break;
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((e) => fail(e?.stack || String(e)));
