import { describe, expect, test } from "vitest";
import { createServerCard } from "../http/server_card.js";
import type { ToolDefinition } from "../core/registrar.js";

describe("MCP server card", () => {
  test("publishes tool annotations and execution metadata", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_calendar",
        description: "Read calendar events",
        inputSchema: {},
        allowedPhases: ["intake"],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        execution: { taskSupport: "forbidden" },
        requiredScopes: ["calendar:read"],
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];

    const card = createServerCard(tools, "1.0.0") as any;
    const tool = card.tools.find((entry: any) => entry.name === "read_calendar");

    expect(card.name).toBe("super-mcp-server");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.execution.taskSupport).toBe("forbidden");
    expect(card.auth.scopes).toEqual(["calendar:read"]);
  });
});
