import { z } from "zod";
import { ENV } from "../config/env.js";
import type { ToolDefinition } from "../core/registrar.js";

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Task aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Task aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const systemTools: ToolDefinition[] = [
  {
    name: "super_mcp_ping",
    description: "Ping server để kiểm tra trạng thái và pipeline middlewares.",
    inputSchema: {
      message: z.string().optional().describe("Tin nhắn ping"),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "forbidden",
    },
    handler: async (args, state) => {
      const msg = (args as { message?: string }).message || "Pong!";
      return {
        content: [
          { type: "text", text: `[SUPER-MCP] ${msg}` },
          { type: "text", text: `Current Phase: ${state.phase}` },
          { type: "text", text: `State Revision: ${state.revision}` },
          { type: "text", text: `Environment: ${ENV.STORAGE_DRIVER} / ${ENV.TELEMETRY_DRIVER}` }
        ],
      };
    },
  },
  {
    name: "super_mcp_long_task",
    description: "Chạy một task tốn thời gian để test kiến trúc Asynchronous Task (Phase 3). Gọi lại đúng lệnh này để poll kết quả.",
    inputSchema: {
      duration: z.number().min(0).max(300).optional().describe("Thời gian chạy mô phỏng (giây, tối đa 300)"),
    },
    allowedPhases: ["intake", "execution", "review", "completed"],
    capabilities: [],
    isAsync: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execution: {
      taskSupport: "forbidden",
    },
    handler: async (args, state, signal) => {
      const seconds = Math.min(Math.max(Number((args as any).duration || 5), 0), 300);
      const ms = seconds * 1000;
      await abortableSleep(ms, signal);
      return {
        content: [{ type: "text", text: `[SUPER-MCP] Task hoàn tất xuất sắc sau ${ms}ms!` }]
      };
    }
  }
];

export default systemTools;
