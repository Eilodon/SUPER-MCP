import { appendFile, rename, stat, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

export class FileLogger implements ITelemetryLogger {
  private logDir = join(os.homedir(), ".super_mcp", "logs");
  private logFile = join(this.logDir, "telemetry.jsonl");
  private rotatedFile = join(this.logDir, "telemetry.jsonl.1");
  private maxBytes = 1024 * 1024;

  async log(event: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true, mode: 0o700 });
      await chmod(this.logDir, 0o700).catch(() => undefined);
      
      try {
        const s = await stat(this.logFile);
        if (s.size >= this.maxBytes) {
          await rename(this.logFile, this.rotatedFile).catch(() => undefined);
        }
      } catch {
        // file may not exist yet
      }

      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        project_id: ENV.MCP_PROJECT_ID,
        tenant_id: ENV.MCP_TENANT_ID,
        ...(redact(meta) as Record<string, unknown>)
      }) + "\n";
      
      await appendFile(this.logFile, payload, { encoding: "utf-8", mode: 0o600 });
      await chmod(this.logFile, 0o600).catch(() => undefined);
    } catch (err) {
      console.error("[SUPER-MCP] File logger failed:", err);
    }
  }
}
