import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

/** Stderr JSONL telemetry. Safe for stdio MCP because protocol frames use stdout. */
export class StderrLogger implements ITelemetryLogger {
  async log(event: string, meta: Record<string, unknown>): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      event,
      project_id: ENV.MCP_PROJECT_ID,
      tenant_id: ENV.MCP_TENANT_ID,
      ...(redact(meta) as Record<string, unknown>)
    };
    console.error(JSON.stringify(payload));
  }
}
