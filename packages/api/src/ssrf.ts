import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Private / loopback / link-local / metadata / reserved ranges that a public
 *  "fetch any URL" service must never reach (the cloud metadata endpoint
 *  169.254.169.254 is inside link-local 169.254/16). */
function buildBlockList(): BlockList {
  const b = new BlockList();
  // IPv4
  b.addSubnet("0.0.0.0", 8, "ipv4");
  b.addSubnet("10.0.0.0", 8, "ipv4");
  b.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  b.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  b.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. 169.254.169.254
  b.addSubnet("172.16.0.0", 12, "ipv4");
  b.addSubnet("192.0.0.0", 24, "ipv4");
  b.addSubnet("192.168.0.0", 16, "ipv4");
  b.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  b.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  b.addSubnet("240.0.0.0", 4, "ipv4"); // reserved
  b.addAddress("255.255.255.255", "ipv4");
  // IPv6
  b.addAddress("::1", "ipv6"); // loopback
  b.addAddress("::", "ipv6"); // unspecified
  b.addSubnet("fc00::", 7, "ipv6"); // unique local
  b.addSubnet("fe80::", 10, "ipv6"); // link-local
  b.addSubnet("ff00::", 8, "ipv6"); // multicast
  return b;
}

const BLOCK = buildBlockList();
const LOOPBACK = (() => {
  const b = new BlockList();
  b.addSubnet("127.0.0.0", 8, "ipv4");
  b.addAddress("::1", "ipv6");
  return b;
})();

/** True if `ip` is in a blocked range. v4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped
 *  and checked as IPv4. When `allowLoopback`, loopback is permitted (local dev). */
export function isBlockedIp(ip: string, allowLoopback = false): boolean {
  let addr = ip;
  let fam = isIP(addr);
  if (fam === 6 && addr.includes(".")) {
    // v4-mapped (e.g. ::ffff:127.0.0.1) — check the embedded v4.
    const v4 = addr.slice(addr.lastIndexOf(":") + 1);
    if (isIP(v4) === 4) {
      addr = v4;
      fam = 4;
    }
  }
  if (fam === 0) return true; // not a valid IP → treat as blocked
  const type = fam === 4 ? "ipv4" : "ipv6";
  if (allowLoopback && LOOPBACK.check(addr, type)) return false;
  return BLOCK.check(addr, type);
}

export type DnsResolver = (hostname: string) => Promise<string[]>;
const defaultResolver: DnsResolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

const BLOCKED_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.localdomain)$/i;

/**
 * Validate a target URL is safe to fetch: http(s) only, and every IP the host
 * resolves to is public. Run at submit time so the service can't be used as an
 * open proxy into the private network / cloud metadata. Returns the parsed URL.
 */
export async function assertPublicUrl(raw: string, opts?: { resolver?: DnsResolver; allowLoopback?: boolean }): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("only http(s) URLs are allowed");

  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!opts?.allowLoopback && BLOCKED_HOST_RE.test(host)) throw new SsrfError(`blocked host: ${host}`);

  const literal = isIP(host) !== 0;
  const ips = literal ? [host] : await safeResolve(opts?.resolver ?? defaultResolver, host);
  if (ips.length === 0) throw new SsrfError(`host does not resolve: ${host}`);
  for (const ip of ips) {
    if (isBlockedIp(ip, opts?.allowLoopback)) throw new SsrfError(`blocked address for ${host}: ${ip}`);
  }
  return u;
}

async function safeResolve(resolver: DnsResolver, host: string): Promise<string[]> {
  try {
    return await resolver(host);
  } catch {
    throw new SsrfError(`DNS resolution failed: ${host}`);
  }
}
