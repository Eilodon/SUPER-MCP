import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../core/registrar.js";

function toolCard(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations || {},
    execution: tool.execution || { taskSupport: "forbidden" },
    requiredScopes: tool.requiredScopes || [],
    allowedPhases: tool.allowedPhases,
  };
}

export function createServerCard(tools: ToolDefinition[], version: string) {
  return {
    schemaVersion: "draft",
    name: "super-mcp-server",
    title: "SUPER-MCP Boilerplate",
    description: "Hardened TypeScript boilerplate for production MCP servers.",
    version,
    protocol: {
      transport: ENV.TRANSPORT_DRIVER,
      statelessHttp: ENV.TRANSPORT_DRIVER === "http",
      mcpEndpoint: ENV.TRANSPORT_DRIVER === "http" ? "/mcp" : undefined,
    },
    auth: {
      mode: ENV.TRANSPORT_DRIVER === "http" ? ENV.MCP_AUTH_MODE : "stdio",
      resourceServer: ENV.MCP_AUTH_MODE === "jwt",
      scopes: [...new Set(tools.flatMap(tool => tool.requiredScopes || []))].sort(),
    },
    tools: [
      {
        name: "check_task_status",
        description: "Check status or result of a background async task.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        execution: { taskSupport: "forbidden" },
        requiredScopes: [],
        allowedPhases: ["intake", "execution", "review", "completed"],
      },
      ...tools.map(toolCard),
    ].sort((a, b) => a.name.localeCompare(b.name)),
    _meta: {
      privacy: {
        storesState: ENV.STORAGE_DRIVER !== "memory",
        stateStore: ENV.STORAGE_DRIVER,
        telemetry: ENV.TELEMETRY_DRIVER,
        encryptedAtRest: Boolean(ENV.MCP_ENCRYPTION_KEY),
      },
      security: {
        safeMode: ENV.MCP_SAFE_MODE,
        pluginIsolationMode: ENV.MCP_PLUGIN_ISOLATION_MODE,
        pluginAutoDiscovery: ENV.MCP_PLUGIN_AUTO_DISCOVERY,
      },
    },
  };
}
