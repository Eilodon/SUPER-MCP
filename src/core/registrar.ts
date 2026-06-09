import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ENV } from "../config/env.js";
import { getRequestContext } from "../security/context.js";
import { globalRateLimiter } from "../middlewares/rate_limit.js";
import { globalQuotaManager } from "../middlewares/quota.js";
import { globalIdempotencyManager } from "../middlewares/idempotency.js";
import { globalGuardrails } from "../middlewares/guardrails.js";
import { globalCredentialVault } from "../middlewares/vault.js";
import { globalExecutionLockManager } from "../middlewares/execution_lock.js";
import { scanToolOutput } from "../middlewares/output_firewall.js";
import { sanitizeJsonValue } from "../security/sanitize.js";
import { telemetry } from "../telemetry/factory.js";
import type { BaseState, Phase } from "../types/schemas.js";
import { assertPluginManifestStable } from "./plugin_loader.js";
import { globalTaskTracker } from "./task_tracker.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };
export type ToolCapability = "fs.read" | "fs.write" | "network" | "secrets.read" | "secrets.write" | "process.spawn" | "destructive";
export type ToolHandler<T = Record<string, unknown>> = (args: unknown, state: BaseState<T>, signal?: AbortSignal) => Promise<ToolResult>;
export type ToolTaskSupport = "forbidden" | "optional" | "required";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolExecution {
  taskSupport?: ToolTaskSupport;
}

export interface ToolDefinition<T = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  allowedPhases: Phase[];
  capabilities?: ToolCapability[];
  isAsync?: boolean;
  requireConfidence?: boolean;
  minConfidence?: number;
  payloadSchema?: z.ZodType<T>;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  requiredScopes?: string[];
  handler: ToolHandler<T>;
}

export class ElicitationRequiredException extends Error {
  constructor(public formParams: any) {
    super("Elicitation required");
    this.name = "ElicitationRequiredException";
  }
}

export interface GetStateOptions {
  reload?: boolean;
}

const SAFE_MODE_BLOCKED_CAPABILITIES = new Set<ToolCapability>([
  "fs.write",
  "network",
  "secrets.write",
  "process.spawn",
  "destructive",
]);

function ensureToolPolicy<T>(tool: ToolDefinition<T>): void {
  if (!ENV.MCP_SAFE_MODE) return;
  const blocked = (tool.capabilities || []).filter(capability => SAFE_MODE_BLOCKED_CAPABILITIES.has(capability));
  if (blocked.length > 0) {
    throw new Error(`[SUPER-MCP] MCP_SAFE_MODE blocked tool '${tool.name}' because it declares capabilities: ${blocked.join(",")}`);
  }
}

function validateConfidence<T>(tool: ToolDefinition<T>, args: unknown): void {
  if (!tool.requireConfidence) return;
  const confidence = (args as any).confidence_level;
  const reasoning = String((args as any).reasoning || "").trim();
  const genericReasoning = [
    /\bas an ai\b/i,
    /\btrust me\b/i,
    /\bi am safe\b/i,
    /\bthis is safe\b/i,
    /\bno risk\b/i,
    /\bi cannot\b/i,
  ].some(pattern => pattern.test(reasoning));
  const hasObservableSignal = /\b(phase|scope|capabilit|tenant|state|idempot|schema|allowlist|read[- ]?only|rollback|audit|lock)\b/i.test(reasoning);
  if (
    confidence === undefined ||
    confidence < (tool.minConfidence || 0.8) ||
    reasoning.length < 40 ||
    genericReasoning ||
    !hasObservableSignal
  ) {
    throw new ElicitationRequiredException({
      message: `AI Confidence (${confidence}) is below threshold or reasoning lacks concrete observable safety signals. Cần người dùng xác nhận thủ công.`
    });
  }
}

function validateScopes<T>(tool: ToolDefinition<T>, scopes: string[], authType: string): void {
  if (authType === "api-key" || authType === "stdio") return;
  const required = tool.requiredScopes || [];
  if (required.length === 0) return;
  const granted = new Set(scopes);
  const missing = required.filter(scope => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error(`[SUPER-MCP] Missing required scope(s): ${missing.join(",")}`);
  }
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timeout: Promise<never> } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason ?? new Error("Client aborted request"));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });

  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`[SUPER-MCP] Tool timed out after ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  return {
    signal: controller.signal,
    timeout,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function runHandlerWithTimeout<T>(tool: ToolDefinition<T>, args: unknown, state: BaseState<T>, parentSignal?: AbortSignal): Promise<ToolResult> {
  if (tool.payloadSchema) {
    state.payload = tool.payloadSchema.parse(state.payload);
  }
  const combined = combineSignal(parentSignal, ENV.MCP_TOOL_TIMEOUT_MS);
  try {
    const result = await Promise.race([
      tool.handler(args, state, combined.signal),
      combined.timeout,
    ]);
    if (tool.payloadSchema) {
      state.payload = tool.payloadSchema.parse(state.payload);
    }
    return result;
  } finally {
    combined.cleanup();
  }
}

function sanitizeResult(rawResult: ToolResult): { result: ToolResult; wasTruncated: boolean } {
  const MAX_PAYLOAD_SIZE = 50000;
  let wasTruncated = false;
  const sanitizedContent = rawResult.content.map(c => {
    if (c.type === "text" && c.text.length > MAX_PAYLOAD_SIZE) {
      wasTruncated = true;
      try {
        const parsed = JSON.parse(c.text);
        if (Array.isArray(parsed)) {
          const sliced = parsed.slice(0, 100);
          return { ...c, text: JSON.stringify(sliced, null, 2) + "\n\n--- [SUPER-MCP WARNING: JSON ARRAY TRUNCATED TO 100 ITEMS TO SAVE TOKENS] ---" };
        }
      } catch {
        // Fallback to string truncation
      }
      return {
        ...c,
        text: c.text.substring(0, MAX_PAYLOAD_SIZE) + "\n\n--- [SUPER-MCP WARNING: PAYLOAD TRUNCATED - DUPLICATED/EXCESSIVE DATA REMOVED. RESULTS MAY BE INCOMPLETE] ---"
      };
    }
    return c;
  });
  return { result: { content: sanitizedContent }, wasTruncated };
}

function isExecutionLockError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return text.includes("Tenant execution lock was lost")
    || text.includes("Tenant execution lock heartbeat failed repeatedly");
}

async function executeTool<T>(tool: ToolDefinition<T>, args: unknown, state: BaseState<T>, signal?: AbortSignal): Promise<ToolResult> {
  ensureToolPolicy(tool);
  globalGuardrails.ensureToolPhase(tool.name, state.phase, tool.allowedPhases);
  const rawResult = await runHandlerWithTimeout(tool, args, state, signal);
  const firewall = scanToolOutput(rawResult);
  if (firewall.violations.length > 0) {
    await telemetry.log("output_firewall_redacted", { tool: tool.name, violations: firewall.violations });
  }
  const { result, wasTruncated } = sanitizeResult(firewall.result);
  if (wasTruncated) {
    await telemetry.log("payload_truncated", { tool: tool.name });
  }
  return result;
}

function startIdempotencyHeartbeat(idempotencyKey: string): () => void {
  if (!globalIdempotencyManager.extendWorking) return () => undefined;
  const intervalMs = Math.max(1000, Math.floor(ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS * 1000 / 3));
  const timer = setInterval(() => {
    globalIdempotencyManager.extendWorking?.(idempotencyKey).catch(error => {
      console.error("[SUPER-MCP] Failed to extend idempotency working TTL:", error);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function applyInvocationGovernance(toolName: string, tenantId: string, requestId: string): Promise<void> {
  await assertPluginManifestStable();

  const rateLimitResult = await globalRateLimiter.check(tenantId);
  if (!rateLimitResult.allowed) {
    await telemetry.log("rate_limit_exceeded", { tool: toolName, tenantId, requestId });
    throw new Error(`[SUPER-MCP] Rate limit exceeded. Vui lòng thử lại sau ${rateLimitResult.retryAfterMs}ms.`);
  }

  const quotaResult = await globalQuotaManager.check(tenantId);
  if (!quotaResult.allowed) {
    await telemetry.log("quota_exceeded", { tool: toolName, tenantId, used: quotaResult.used, requestId });
    throw new Error(`[SUPER-MCP] Quota exceeded. Bạn đã dùng hết ${quotaResult.used} requests hôm nay.`);
  }
}

export async function closeMiddlewareResources(): Promise<void> {
  await Promise.allSettled([
    globalRateLimiter.close?.(),
    globalQuotaManager.close?.(),
    globalIdempotencyManager.close?.(),
    globalCredentialVault.close?.(),
    globalExecutionLockManager.close?.(),
  ]);
}

export function registerTools<T = Record<string, unknown>>(
  server: McpServer,
  tools: ToolDefinition<T>[],
  getState: (tenantId: string, options?: GetStateOptions) => Promise<BaseState<T>>,
  saveState: (state: BaseState<T>) => Promise<void>,
): void {
  server.registerTool(
    "check_task_status",
    {
      description: "Kiểm tra trạng thái hoặc kết quả của một Async Task đang chạy ngầm. Luôn dùng tool này thay vì gọi lại tool gốc.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: "forbidden",
      },
      inputSchema: {
        job_id: z.string().describe("Mã job_id (idempotencyKey) được trả về khi bắt đầu async task.")
      }
    } as any,
    async (args: unknown) => {
      const ctx = getRequestContext();
      const cleanArgs = sanitizeJsonValue(args) as Record<string, unknown>;
      await applyInvocationGovernance("check_task_status", ctx.tenantId, ctx.requestId);
      const jobId = cleanArgs.job_id as string;
      if (!jobId) throw new Error("job_id is required");
      if (!globalIdempotencyManager.isValidKey(jobId)) {
        return { content: [{ type: "text", text: `[SUPER-MCP] Error: Invalid task id format.` }] };
      }

      const cached = await globalIdempotencyManager.peek(jobId);
      if (!cached) {
        return { content: [{ type: "text", text: `[SUPER-MCP] Error: Task not found or expired.` }] };
      }
      if (cached.status === "working") {
        return { content: [{ type: "text", text: `[SYSTEM] Task is still working. DO NOT poll again immediately. Please WAIT AT LEAST 5 SECONDS before retrying or continue with other tasks.` }] };
      }
      return cached || { content: [{ type: "text", text: `[SUPER-MCP] Task completed, nhưng không có dữ liệu trả về.` }] };
    }
  );

  for (const tool of tools) {
    if (ENV.MCP_SAFE_MODE && (tool.capabilities || []).some(c => SAFE_MODE_BLOCKED_CAPABILITIES.has(c))) {
      console.error(`[SUPER-MCP] Tool '${tool.name}' not registered because MCP_SAFE_MODE blocks one or more declared capabilities.`);
      continue;
    }

    if (tool.requireConfidence) {
      tool.inputSchema.confidence_level = z.number().min(0).max(1).describe("Độ tự tin của AI vào tính an toàn của tác vụ (0.0 đến 1.0)");
      tool.inputSchema.reasoning = z.string().describe("Giải thích chi tiết tại sao hành động này là an toàn và không gây hại hệ thống");
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execution: tool.execution || { taskSupport: "forbidden" },
      } as any,
      async (args: unknown, extra: { signal?: AbortSignal } = {}) => {
        const ctx = getRequestContext();
        const tenantId = ctx.tenantId;
        const owner = `${ctx.authType}:${ctx.clientId}:${ctx.userId}`;
        const cleanArgs = sanitizeJsonValue(args);

        await applyInvocationGovernance(tool.name, tenantId, ctx.requestId);
        validateScopes(tool, ctx.scopes, ctx.authType);

        try {
          validateConfidence(tool, cleanArgs);
        } catch (error) {
          if (error instanceof ElicitationRequiredException) {
            await telemetry.log("elicitation_requested", { tool: tool.name, tenantId, requestId: ctx.requestId });
            return { content: [{ type: "text", text: `[ELICITATION_REQUIRED] ${error.formParams.message}` }] };
          }
          throw error;
        }

        const idempotencyKey = globalIdempotencyManager.generateKey(tenantId, tool.name, cleanArgs, owner);
        const { locked, cached: cachedResult } = await globalIdempotencyManager.tryAcquireOrGetCached(idempotencyKey);
        
        if (!locked) {
          if (cachedResult && cachedResult.status === "working") {
            await telemetry.log("async_task_polling", { tool: tool.name, tenantId, requestId: ctx.requestId });
            return { content: [{ type: "text", text: `[SYSTEM] Task is still running. Vui lòng dùng tool 'check_task_status' với job_id: ${idempotencyKey}. DO NOT poll immediately, wait at least 5 seconds.` }] };
          }
          await telemetry.log("idempotency_cache_hit", { tool: tool.name, tenantId, requestId: ctx.requestId });
          return cachedResult;
        }

        await telemetry.log("tool_execution_started", { tool: tool.name, tenantId, requestId: ctx.requestId, isAsync: tool.isAsync });

        if (tool.isAsync) {
          if (globalTaskTracker.isDraining()) {
            await globalIdempotencyManager.release(idempotencyKey);
            throw new Error("[SUPER-MCP] Server is shutting down and is not accepting new async tasks.");
          }
          const taskPromise = globalExecutionLockManager.withTenantLock(tenantId, async (lockSignal) => {
            const stopHeartbeat = startIdempotencyHeartbeat(idempotencyKey);
            const signals = [extra.signal, lockSignal].filter(Boolean) as AbortSignal[];
            const combinedSignal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;
            try {
              const state = await getState(tenantId, { reload: true });
              const result = await executeTool(tool, cleanArgs, state, combinedSignal);
              await saveState(state);
              await globalIdempotencyManager.commit(idempotencyKey, result);
              await telemetry.log("async_task_completed", { tool: tool.name, tenantId, requestId: ctx.requestId });
            } catch (error) {
              await telemetry.log("async_task_failed", { tool: tool.name, tenantId, requestId: ctx.requestId, error: String(error) });

              if (isExecutionLockError(error)) {
                await globalIdempotencyManager.release(idempotencyKey);
                throw error;
              }

              await globalIdempotencyManager.commit(idempotencyKey, {
                content: [{ type: "text", text: `[SUPER-MCP] Async Task Failed: ${String(error)}` }]
              });
            } finally {
              stopHeartbeat();
            }
          });
          if (!globalTaskTracker.track(taskPromise, ENV.MCP_TOOL_TIMEOUT_MS + 60000)) {
            await globalIdempotencyManager.release(idempotencyKey);
            throw new Error("[SUPER-MCP] Server is shutting down and is not accepting new async tasks.");
          }
          return { content: [{ type: "text", text: `[SUPER-MCP] Async Task started. Vui lòng dùng tool 'check_task_status' với job_id: ${idempotencyKey} để kiểm tra kết quả.` }] };
        }

        return globalExecutionLockManager.withTenantLock(tenantId, async (lockSignal) => {
          const signals = [extra.signal, lockSignal].filter(Boolean) as AbortSignal[];
          const combinedSignal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;
          try {
            const state = await getState(tenantId, { reload: true });
            const result = await executeTool(tool, cleanArgs, state, combinedSignal);
            await saveState(state);
            await globalIdempotencyManager.commit(idempotencyKey, result);
            await telemetry.log("tool_execution_completed", { tool: tool.name, tenantId, requestId: ctx.requestId });
            return result;
          } catch (error) {
            await globalIdempotencyManager.release(idempotencyKey);
            await telemetry.log("tool_execution_failed", { tool: tool.name, tenantId, requestId: ctx.requestId, error: String(error) });
            throw error;
          }
        });
      }
    );
  }
}
