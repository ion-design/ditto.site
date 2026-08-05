import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertEntryAllowedByRobots } from "../src/crawl/robotsGuard.js";

const originalFetch = globalThis.fetch;

function mockFetch(fn: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    configurable: true,
    writable: true,
  });
});

describe("assertEntryAllowedByRobots", () => {
  it("throws a user-facing error when the entry path is disallowed", async () => {
    mockFetch(async () => new Response("User-agent: *\nDisallow: /private\n"));

    await assert.rejects(
      assertEntryAllowedByRobots("https://example.com/private/page"),
      /robots\.txt at https:\/\/example\.com disallows crawling \/private\/page — this site opts out of automated access, refusing to clone it/,
    );
  });

  it("passes when the entry path is allowed", async () => {
    mockFetch(async () => new Response("User-agent: *\nDisallow: /private\n"));

    await assertEntryAllowedByRobots("https://example.com/public/page");
  });

  it("passes when robots.txt is missing or failing", async () => {
    mockFetch(async () => new Response("missing", { status: 404 }));
    await assertEntryAllowedByRobots("https://example.com/private/page");

    mockFetch(async () => {
      throw new Error("network down");
    });
    await assertEntryAllowedByRobots("https://example.com/private/page");
  });

  it("blocks every path for Disallow: /", async () => {
    mockFetch(async () => new Response("User-agent: *\nDisallow: /\n"));

    await assert.rejects(
      assertEntryAllowedByRobots("https://example.com/anything"),
      /disallows crawling \/anything/,
    );
  });
});
