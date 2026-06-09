import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ENV } from "./config/env.js";
import { SuperMcpRuntime } from "./core/runtime.js";
import { PluginLoader } from "./core/plugin_loader.js";
import { withRequestContext } from "./security/context.js";
import { authenticateHttpRequest } from "./security/auth.js";
import { isBodyTooLargeError, isJsonRequest } from "./http/security.js";
import { createServerCard } from "./http/server_card.js";
import { protectedResourceMetadata, resourceMetadataPath } from "./http/oauth_metadata.js";

let runtime: SuperMcpRuntime;

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isAllowedHost(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const hostWithoutPort = host.split(":")[0];
  return allowedHosts.has(host) || allowedHosts.has(hostWithoutPort);
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function main() {
  const tools = await PluginLoader.loadAll();
  runtime = new SuperMcpRuntime("1.0.0", tools);
  await runtime.initialize();
  const state = await runtime.getDefaultState();

  console.error(`[SUPER-MCP] Server Started v1.0.0`);
  console.error(`[SUPER-MCP] Tenant: ${ENV.MCP_TENANT_ID} | Project: ${ENV.MCP_PROJECT_ID}`);
  console.error(`[SUPER-MCP] Config: Transport=${ENV.TRANSPORT_DRIVER}, Storage=${ENV.STORAGE_DRIVER}, Telemetry=${ENV.TELEMETRY_DRIVER}`);
  console.error(`[SUPER-MCP] Security: Encrypted=${!!ENV.MCP_ENCRYPTION_KEY}, SafeMode=${ENV.MCP_SAFE_MODE}`);
  console.error(`[SUPER-MCP] Current Phase: ${state.phase}`);

  if (ENV.TRANSPORT_DRIVER === "http") {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");
    const cors = (await import("cors")).default;
    const express = (await import("express")).default;

    const app = createMcpExpressApp();
    const allowedOrigins = new Set(parseList(ENV.ALLOWED_ORIGINS));
    const allowedHosts = new Set(parseList(ENV.ALLOWED_HOSTS).map(h => h.toLowerCase()));

    app.disable("x-powered-by");

    app.use((req, res, next) => {
      if (!isAllowedHost(req.headers.host, allowedHosts)) {
        res.status(403).json({ error: "Invalid Host" });
        return;
      }
      next();
    });

    app.use(cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed"));
      }
    }));

    app.get("/.well-known/mcp.json", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get("/.well-known/mcp-server-card", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(createServerCard(tools, "1.0.0"));
    });

    app.get(resourceMetadataPath(), (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(protectedResourceMetadata(tools));
    });

    app.use("/mcp", (req, res, next) => {
      const contentType = req.headers["content-type"];
      if (!isJsonRequest(req.method, Array.isArray(contentType) ? contentType[0] : contentType)) {
        res.status(415).json(jsonRpcError(-32000, "Unsupported media type. Use application/json."));
        return;
      }
      next();
    });

    app.use("/mcp", express.json({ limit: ENV.MCP_HTTP_BODY_LIMIT, type: ["application/json", "application/*+json"] }));

    app.use("/mcp", (error: any, req: any, res: any, next: any) => {
      if (isBodyTooLargeError(error)) {
        res.status(413).json(jsonRpcError(-32000, "Payload too large."));
        return;
      }
      next(error);
    });

    app.get("/health/liveness", (req, res) => { res.json({ status: "alive", version: "1.0.0" }); });
    app.get("/health/readiness", async (req, res) => {
      try {
        const healthy = await runtime.healthCheck();
        res.status(healthy ? 200 : 503).json({ status: healthy ? "ready" : "not_ready", storage: ENV.STORAGE_DRIVER });
      } catch {
        res.status(503).json({ status: "not_ready", storage: ENV.STORAGE_DRIVER });
      }
    });

    app.use("/mcp", async (req, res, next) => {
      try {
        (req as any).superMcpContext = await authenticateHttpRequest(req.headers as Record<string, string | string[] | undefined>);
        next();
      } catch (error) {
        if (ENV.MCP_AUTH_MODE === "jwt") {
          const forwardedProto = req.headers["x-forwarded-proto"];
          const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol || "http";
          const forwardedHost = req.headers["x-forwarded-host"];
          const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers.host;
          const metadataUrl = host ? `${proto}://${host}${resourceMetadataPath()}` : resourceMetadataPath();
          res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
        }
        res.status(401).json({ error: "Unauthorized" });
      }
    });

    app.post("/mcp", async (req, res) => {
      const ctx = (req as any).superMcpContext;
      await withRequestContext(ctx, async () => {
        let server: Awaited<ReturnType<typeof runtime.connectEphemeral>> | undefined;
        let transport: InstanceType<typeof StreamableHTTPServerTransport> | undefined;
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          server = await runtime.connectEphemeral(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("[SUPER-MCP] Error handling MCP HTTP request:", error);
          if (!res.headersSent) {
            res.status(500).json(jsonRpcError(-32603, "Internal server error"));
          }
        } finally {
          await transport?.close().catch(() => undefined);
          await server?.close().catch(() => undefined);
        }
      });
    });

    app.get("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    app.delete("/mcp", (req, res) => {
      res.status(405).json(jsonRpcError(-32000, "Method not allowed in stateless HTTP mode."));
    });

    const server = app.listen(ENV.HTTP_PORT, ENV.HTTP_HOST, () => {
      console.error(`[SUPER-MCP] Server listening on HTTP ${ENV.HTTP_HOST}:${ENV.HTTP_PORT} at /mcp`);
    });
    (runtime as any)._httpServer = server;
  } else {
    const transport = new StdioServerTransport();
    await runtime.connect(transport);
  }

  const shutdown = async (signal: string) => {
    console.error(`\n[SUPER-MCP] Nhận tín hiệu ${signal}. Tiến hành tắt an toàn (Graceful Shutdown)...`);
    try {
      if ((runtime as any)._httpServer) {
        console.error(`[SUPER-MCP] Đang đóng HTTP Server...`);
        await new Promise<void>((resolve, reject) => {
          (runtime as any)._httpServer.close((err: any) => err ? reject(err) : resolve());
        });
      }

      const { globalTaskTracker } = await import("./core/task_tracker.js");
      globalTaskTracker.beginDraining();
      await globalTaskTracker.awaitAll(30000);
      await runtime.close();
      console.error("[SUPER-MCP] Đã tắt an toàn.");
      process.exit(0);
    } catch (err) {
      console.error("[SUPER-MCP] Lỗi khi tắt:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[SUPER-MCP] Fatal Crash:", error);
  process.exit(1);
});
