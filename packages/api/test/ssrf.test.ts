import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, isBlockedIp, SsrfError } from "../src/ssrf.js";

test("isBlockedIp: private / loopback / link-local / metadata / ULA are blocked", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedIp: public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
  assert.equal(isBlockedIp("127.0.0.1", true), false, "loopback allowed when opted in");
});

test("assertPublicUrl: rejects non-http, IP literals in blocked ranges, localhost", async () => {
  await assert.rejects(() => assertPublicUrl("ftp://example.com/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://10.1.2.3/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://localhost:3000/"), SsrfError);
});

test("assertPublicUrl: blocks hostnames that resolve to private IPs (DNS rebinding)", async () => {
  await assert.rejects(() => assertPublicUrl("http://rebind.evil.test/", { resolver: async () => ["10.0.0.5"] }), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://nope.test/", { resolver: async () => [] }), SsrfError);
});

test("assertPublicUrl: allows public hostnames + opt-in loopback", async () => {
  const u = await assertPublicUrl("https://example.test/path", { resolver: async () => ["93.184.216.34"] });
  assert.equal(u.hostname, "example.test");
  const u2 = await assertPublicUrl("http://127.0.0.1:8080/", { allowLoopback: true });
  assert.equal(u2.port, "8080");
});
