import { randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeCloneRequestOptions } from "@cloner/core";
import type { Backend } from "./backend.js";
import { createMcpServer } from "./mcp.js";
import { apiKeyAuth, hashApiKey, rateLimit, type AuthConfig } from "./auth.js";

const OptionsSchema = z
  .object({
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

    // Deprecated compatibility aliases and dev-only escape hatches.
    multiPage: z.boolean().optional(),
    humanizeMode: z.enum(["tailwind", "css"]).optional(),
    viewports: z.array(z.number().int().positive()).min(1).optional(),
    interactions: z.boolean().optional(),
    components: z.boolean().optional(),
    motion: z.boolean().optional(),
    noCache: z.boolean().optional(),
  })
  .strict();

const CloneRequest = z.object({
  url: z.string().url(),
  options: OptionsSchema.optional(),
});

const SignupRequest = z
  .object({
    email: z.string().email().max(320).transform((s) => s.trim().toLowerCase()),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const SignupVerifyRequest = z
  .object({
    token: z.string().min(24).max(256),
  })
  .strict();

export type SignupDeps = {
  createApiKey: (input: { keyHash: string; label: string; rateLimit?: number }) => Promise<void>;
  defaultRateLimit?: number;
  rateLimitPerHour?: number;
  directEnabled?: boolean;
  email?: {
    createToken: (input: { email: string; tokenHash: string; expiresAt: Date }) => Promise<void>;
    consumeToken: (tokenHash: string) => Promise<{ email: string } | undefined>;
    sendVerificationEmail: (input: { email: string; verifyUrl: string; expiresAt: Date }) => Promise<void>;
    verifyUrl: string;
    tokenTtlMs: number;
  };
};

export type AppDeps = {
  backend: Backend;
  /** absolute base URL used in MCP-returned references (binary/bundle URLs). */
  baseUrl?: string;
  /** mount the MCP Streamable-HTTP endpoint at /mcp (default true). */
  mcp?: boolean;
  /** require an API key on /v1/* and /mcp (omit = open). */
  auth?: AuthConfig;
  /** per-window request cap on /v1/* and /mcp (omit = unlimited). */
  rateLimitPerMinute?: number;
  /** public key minting endpoint at POST /v1/signup (omit = disabled). */
  signup?: SignupDeps;
  /** browser origins allowed to call public signup routes. */
  signupCorsOrigins?: string[];
  /** SSRF guard run on submit (omit = no check — set in production). Throws to reject. */
  assertUrl?: (url: string) => Promise<void>;
};

/** Build the Hono app over a Backend. The in-memory backend (M1) runs clones inline
 *  (POST → 200 + file map); the DB backend (M2) enqueues (POST → 202) and the worker
 *  fills the result (poll via GET). The HTTP surface is identical either way. */
export function createApp(deps: AppDeps): Hono {
  const { backend } = deps;
  const app = new Hono();
  const signupCorsOrigins = deps.signupCorsOrigins ?? [];

  if (signupCorsOrigins.length > 0) {
    const allowedOrigins = new Set(signupCorsOrigins);
    const signupCors = cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 86400,
    });
    app.use("/v1/signup", signupCors);
    app.use("/v1/signup/*", signupCors);
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  if (deps.signup) {
    const signup = deps.signup;
    const signupRateLimit = signup.rateLimitPerHour ?? 3;
    const signupLimiter = rateLimit({ perMinute: signupRateLimit, windowMs: 60 * 60 * 1000 });
    const mintKey = async (email: string, label?: string) => {
      const apiKey = `dtto_live_${randomBytes(32).toString("base64url")}`;
      const storedLabel = label ? `${email} (${label})` : email;
      await signup.createApiKey({
        keyHash: hashApiKey(apiKey),
        label: storedLabel,
        rateLimit: signup.defaultRateLimit,
      });
      return apiKey;
    };

    const directSignupHandler = async (c: Context) => {
      const body = await c.req.json().catch(() => null);
      const parsed = SignupRequest.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "invalid request", details: parsed.error.flatten() }, 400);
      }
      const apiKey = await mintKey(parsed.data.email, parsed.data.label);
      return c.json(
        {
          apiKey,
          message: "Save this key now; it will not be shown again.",
        },
        201,
      );
    };

    if (signup.directEnabled !== false) {
      if (signupRateLimit > 0) app.post("/v1/signup", signupLimiter, directSignupHandler);
      else app.post("/v1/signup", directSignupHandler);
    }

    const emailSignup = signup.email;
    if (emailSignup) {
      const requestSignupHandler = async (c: Context) => {
        const body = await c.req.json().catch(() => null);
        const parsed = SignupRequest.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "invalid request", details: parsed.error.flatten() }, 400);
        }
        const rawToken = `dtto_signup_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + emailSignup.tokenTtlMs);
        const url = new URL(emailSignup.verifyUrl);
        url.searchParams.set("token", rawToken);
        await emailSignup.createToken({
          email: parsed.data.email,
          tokenHash: hashApiKey(rawToken),
          expiresAt,
        });
        await emailSignup.sendVerificationEmail({
          email: parsed.data.email,
          verifyUrl: url.toString(),
          expiresAt,
        });
        return c.json({ message: "Check your email for a verification link." }, 202);
      };

      const verifySignupHandler = async (c: Context) => {
        const body = await c.req.json().catch(() => null);
        const parsed = SignupVerifyRequest.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "invalid request", details: parsed.error.flatten() }, 400);
        }
        const token = await emailSignup.consumeToken(hashApiKey(parsed.data.token));
        if (!token) {
          return c.json({ error: "invalid or expired signup token" }, 400);
        }
        const apiKey = await mintKey(token.email);
        return c.json(
          {
            apiKey,
            message: "Save this key now; it will not be shown again.",
          },
          201,
        );
      };

      if (signupRateLimit > 0) app.post("/v1/signup/request", signupLimiter, requestSignupHandler);
      else app.post("/v1/signup/request", requestSignupHandler);
      app.post("/v1/signup/verify", verifySignupHandler);
    }
  }

  const skipSignup = (mw: MiddlewareHandler): MiddlewareHandler => {
    return async (c, next) => {
      if (c.req.path === "/v1/signup" || c.req.path === "/v1/signup/request" || c.req.path === "/v1/signup/verify") return next();
      return mw(c, next);
    };
  };

  // Protect the clone API + MCP surfaces (not /healthz or /v1/signup). Auth
  // before rate-limit so the limiter can key by API key.
  if (deps.auth) {
    const mw = apiKeyAuth(deps.auth);
    app.use("/v1/*", skipSignup(mw));
    app.use("/mcp", mw);
  }
  if (deps.rateLimitPerMinute && deps.rateLimitPerMinute > 0) {
    const mw = rateLimit({ perMinute: deps.rateLimitPerMinute });
    app.use("/v1/*", skipSignup(mw));
    app.use("/mcp", mw);
  }

  app.post("/v1/clones", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CloneRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", details: parsed.error.flatten() }, 400);
    }
    const { url, options } = parsed.data;
    if (!/^https?:\/\//i.test(url)) {
      return c.json({ error: "url must be http(s)" }, 400);
    }
    // SSRF guard (production): block private/link-local/metadata targets.
    if (deps.assertUrl) {
      try {
        await deps.assertUrl(url);
      } catch (e) {
        return c.json({ error: "url not allowed", reason: String((e as Error).message ?? e) }, 400);
      }
    }
    // Header alias for the per-request cache bypass.
    const noCacheHeader = (c.req.header("cache-control") ?? "").toLowerCase().includes("no-cache");
    const normalizedOptions = normalizeCloneRequestOptions(options ?? {});
    const opts = noCacheHeader ? { ...normalizedOptions, noCache: true } : normalizedOptions;

    try {
      const out = await backend.submit(url, opts);
      if (out.status === "queued") return c.json({ jobId: out.jobId, status: "queued" }, 202);
      return c.json(out.result, 200);
    } catch (e) {
      return c.json({ status: "failed", error: String(e).slice(0, 500) }, 500);
    }
  });

  app.get("/v1/clones", async (c) => {
    return c.json({ clones: await backend.list() });
  });

  app.get("/v1/clones/:id", async (c) => {
    const view = await backend.status(c.req.param("id"));
    if (!view) return c.json({ error: "not found" }, 404);
    return c.json(view, 200);
  });

  app.get("/v1/clones/:id/result", async (c) => {
    const out = await backend.result(c.req.param("id"));
    if (!out) return c.json({ error: "not found" }, 404);
    if (!out.ready) return c.json({ jobId: c.req.param("id"), status: out.status, error: out.error }, 409);
    return c.json(out.result, 200);
  });

  app.get("/v1/clones/:id/bundle", async (c) => {
    const fmt = c.req.query("format") === "zip" ? "zip" : "tgz";
    const b = await backend.bundle(c.req.param("id"), fmt);
    if (!b) return c.json({ error: "not found or not ready" }, 404);
    if (b.url) return c.redirect(b.url, 302); // S3: hand off to the presigned URL
    c.header("content-type", fmt === "zip" ? "application/zip" : "application/gzip");
    c.header("content-disposition", `attachment; filename="clone-${c.req.param("id")}.${fmt}"`);
    c.header("content-length", String(b.bytes.length));
    c.header("x-content-sha256", b.sha256);
    return c.body(b.bytes);
  });

  app.get("/v1/clones/:id/files/:path{.+}", async (c) => {
    const file = await backend.file(c.req.param("id"), c.req.param("path"));
    if (!file) return c.json({ error: "file not found" }, 404);
    c.header("content-type", file.contentType);
    c.header("content-length", String(file.bytes.length));
    return c.body(file.bytes);
  });

  app.delete("/v1/clones/:id", async (c) => {
    const ok = await backend.remove(c.req.param("id"));
    return c.json({ deleted: ok }, ok ? 200 : 404);
  });

  // MCP over Streamable-HTTP (stateless): a fresh server+transport per request.
  // Requires the Node http req/res from @hono/node-server (not available under
  // app.request — MCP is exercised in tests via the in-memory transport instead).
  if (deps.mcp !== false) {
    app.all("/mcp", async (c) => {
      const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse };
      if (!env?.incoming || !env?.outgoing) {
        return c.json({ error: "MCP requires the Node HTTP server (run via @hono/node-server)" }, 501);
      }
      const server = createMcpServer(backend, { baseUrl: deps.baseUrl });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      env.outgoing.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
      await transport.handleRequest(env.incoming, env.outgoing, body);
      return RESPONSE_ALREADY_SENT;
    });
  }

  return app;
}
