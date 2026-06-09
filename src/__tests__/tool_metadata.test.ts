import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import systemTools from "../plugins/system.tool.js";

describe("tool metadata", () => {
  test("system tools include MCP annotations and execution metadata", () => {
    const ping = systemTools.find(tool => tool.name === "super_mcp_ping");
    const longTask = systemTools.find(tool => tool.name === "super_mcp_long_task");

    expect(ping?.annotations?.readOnlyHint).toBe(true);
    expect(ping?.annotations?.idempotentHint).toBe(true);
    expect(ping?.execution?.taskSupport).toBe("forbidden");

    expect(longTask?.annotations?.readOnlyHint).toBe(false);
    expect(longTask?.annotations?.idempotentHint).toBe(false);
    expect(longTask?.execution?.taskSupport).toBe("forbidden");
  });

  test("registrar forwards annotations and execution metadata to registerTool", async () => {
    const source = await readFile(new URL("../core/registrar.ts", import.meta.url), "utf-8");
    expect(source).toContain("annotations: tool.annotations");
    expect(source).toContain('execution: tool.execution || { taskSupport: "forbidden" }');
  });
});
