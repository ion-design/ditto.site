// Local capture bridge: Chromium → (this HTTP proxy, TLS-terminated locally) → Node
// CONNECT-tunnel through the agent proxy → origin. Exists because Chromium 141's TLS
// ClientHello is closed by the egress proxy during the handshake, while Node/curl/openssl
// ClientHellos are accepted. Chromium talks plaintext-after-TLS to us (we present a static
// self-signed cert; capture runs with ignoreHTTPSErrors so host/CA mismatch is fine), and
// WE re-originate every request over a Node TLS socket the proxy is happy with.
import net from "node:net";
import http from "node:http";
import tls from "node:tls";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const KEY = fs.readFileSync(join(DIR, "key.pem"));
const CERT = fs.readFileSync(join(DIR, "cert.pem"));
const CA = fs.readFileSync("/root/.ccr/ca-bundle.crt");
const LISTEN_PORT = Number(process.env.BRIDGE_PORT || 8899);

// The real egress proxy we tunnel through (the one Chromium can't TLS-handshake with).
const upstream = new URL(process.env.UPSTREAM_PROXY || "http://127.0.0.1:37671");
const UP_HOST = upstream.hostname;
const UP_PORT = Number(upstream.port || 80);

/** Open a socket to `host:port` by CONNECT-tunnelling through the agent proxy, then (for
 *  443) upgrading to TLS that the proxy accepts. Calls back with the ready socket. */
function tunnel(host, port, cb) {
  const raw = net.connect(UP_PORT, UP_HOST);
  let settled = false;
  const fail = (e) => { if (!settled) { settled = true; cb(e); } raw.destroy(); };
  raw.once("error", fail);
  raw.on("connect", () => {
    raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    raw.removeListener("data", onData);
    const status = buf.slice(0, buf.indexOf("\r\n")).toString();
    if (!/ 200 /.test(status)) return fail(new Error(`upstream CONNECT ${host}:${port} → ${status}`));
    raw.removeListener("error", fail);
    if (port === 443) {
      const t = tls.connect({ socket: raw, servername: host, ca: CA, ALPNProtocols: ["http/1.1"] }, () => {
        if (!settled) { settled = true; cb(null, t); }
      });
      t.once("error", (e) => { if (!settled) { settled = true; cb(e); } });
    } else {
      if (!settled) { settled = true; cb(null, raw); }
    }
  };
  raw.on("data", onData);
}

// An internal HTTP server that PARSES the plaintext requests Chromium sends us (after we
// TLS-terminate its tunnel) and re-issues them to the origin over a fresh upstream tunnel.
const origin = http.createServer((creq, cres) => {
  const host = creq.socket.__host;
  const opts = {
    method: creq.method,
    path: creq.url,
    headers: { ...creq.headers, host: creq.headers.host || host, connection: "close" },
    createConnection: (_o, cb) => tunnel(host, 443, cb),
  };
  const preq = http.request(opts, (pres) => {
    cres.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(cres);
  });
  preq.once("error", (e) => { if (!cres.headersSent) cres.writeHead(502); cres.end("bridge upstream error: " + e.message); });
  creq.pipe(preq);
});
origin.on("clientError", (_e, sock) => sock.destroy());

const proxy = http.createServer((req, res) => {
  // Plain-HTTP proxied request (rare for these sites): forward host:80 through the tunnel.
  const u = new URL(req.url);
  const opts = { method: req.method, path: u.pathname + u.search, headers: { ...req.headers, connection: "close" },
    createConnection: (_o, cb) => tunnel(u.hostname, Number(u.port || 80), cb) };
  const preq = http.request(opts, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
  preq.once("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end("bridge error: " + e.message); });
  req.pipe(preq);
});

proxy.on("connect", (req, clientSocket) => {
  const [host] = req.url.split(":");
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  // We are the TLS *server* for Chromium's tunnel; present our static cert.
  const tlsSock = new tls.TLSSocket(clientSocket, { isServer: true, key: KEY, cert: CERT });
  tlsSock.__host = host;
  tlsSock.on("error", () => tlsSock.destroy());
  // Hand the decrypted byte stream to the internal HTTP parser.
  origin.emit("connection", tlsSock);
});
proxy.on("clientError", (_e, sock) => sock.destroy());

proxy.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`bridge listening on http://127.0.0.1:${LISTEN_PORT} → upstream ${UP_HOST}:${UP_PORT}`);
});
