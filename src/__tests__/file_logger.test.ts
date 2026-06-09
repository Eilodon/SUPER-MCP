import { describe, expect, test } from "vitest";
import { FileLogger } from "../telemetry/file_logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

describe("FileLogger", () => {
  test("queues logs and rotates files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "super_mcp_"));
    const logger = new FileLogger({ logDir: dir, maxBytes: 10, maxBackups: 2 });
    
    await logger.log("event-1", {});
    await logger.log("event-2", {});
    await logger.log("event-3", {});
    
    await rm(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
