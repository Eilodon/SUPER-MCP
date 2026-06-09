import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { redact } from "./redaction.js";

/** Cloud/container JSONL telemetry. Do not use with stdio transport. */
export class StdoutLogger implements ITelemetryLogger {
  async log(event: string, meta: Record<string, unknown>): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      event,
      project_id: ENV.MCP_PROJECT_ID,
      tenant_id: ENV.MCP_TENANT_ID,
      ...(redact(meta) as Record<string, unknown>)
    };
    console.log(JSON.stringify(payload));
  }
}
