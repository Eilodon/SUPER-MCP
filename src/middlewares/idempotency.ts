import { createHash } from "node:crypto";
import { ENV } from "../config/env.js";
import { Redis } from "ioredis";
import { getRedisClient } from "../storage/redis_client.js";

export function assertJsonSerializable(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") return;
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol" || valueType === "undefined") {
    throw new Error(`[SUPER-MCP] Idempotency args must be JSON-serializable. Invalid value at ${path}.`);
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new Error(`[SUPER-MCP] Idempotency args must be plain JSON, not ${value.constructor.name}, at ${path}.`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`[SUPER-MCP] Idempotency args must not contain circular references at ${path}.`);
    seen.add(value);
    value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (valueType === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`[SUPER-MCP] Idempotency args must be plain JSON objects at ${path}.`);
    }
    if (seen.has(value as object)) throw new Error(`[SUPER-MCP] Idempotency args must not contain circular references at ${path}.`);
    seen.add(value as object);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSerializable(child, `${path}.${key}`, seen);
    }
    seen.delete(value as object);
  }
}

export function deterministicStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(deterministicStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  const props = keys.map(k => `"${k}":${deterministicStringify(obj[k])}`).join(",");
  return `{${props}}`;
}

export interface IIdempotencyManager {
  generateKey(tenantId: string, toolName: string, args: unknown, owner?: string): string;
  isValidKey(idempotencyKey: string): boolean;
  peek(idempotencyKey: string): Promise<any | null>;
  tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: any }>;
  commit(idempotencyKey: string, result: any): Promise<void>;
  release(idempotencyKey: string): Promise<void>;
  extendWorking?(idempotencyKey: string): Promise<void>;
  close?(): Promise<void>;
}

function keyPrefix(): string {
  return `super_mcp:idempotency:${ENV.MCP_PROJECT_ID}:`;
}

function makeKey(hash: string): string {
  return `${keyPrefix()}${hash}`;
}

function workingRecord() {
  return { status: "working", startedAt: new Date().toISOString() };
}

class MemoryIdempotencyManager implements IIdempotencyManager {
  private cache = new Map<string, { value: any; expiresAt: number }>();
  private readonly resultTtlMs = ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS * 1000;
  private readonly workingTtlMs = ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS * 1000;

  private cleanup(key?: string): void {
    const now = Date.now();
    if (key) {
      const entry = this.cache.get(key);
      if (entry && entry.expiresAt <= now) this.cache.delete(key);
      return;
    }
    for (const [k, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) this.cache.delete(k);
    }
  }

  generateKey(tenantId: string, toolName: string, args: unknown, owner = "anonymous"): string {
    assertJsonSerializable(args);
    const payload = deterministicStringify({ tenantId, toolName, owner, args });
    return makeKey(createHash("sha256").update(payload).digest("hex"));
  }

  isValidKey(idempotencyKey: string): boolean {
    return idempotencyKey.startsWith(keyPrefix()) && /^[a-f0-9]{64}$/.test(idempotencyKey.slice(keyPrefix().length));
  }

  async peek(idempotencyKey: string): Promise<any | null> {
    if (!this.isValidKey(idempotencyKey)) return null;
    this.cleanup(idempotencyKey);
    return this.cache.get(idempotencyKey)?.value || null;
  }

  async tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: any }> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    this.cleanup(idempotencyKey);
    if (this.cache.has(idempotencyKey)) {
      return { locked: false, cached: this.cache.get(idempotencyKey)?.value };
    }
    this.cache.set(idempotencyKey, { value: workingRecord(), expiresAt: Date.now() + this.workingTtlMs });
    this.cleanup();
    return { locked: true };
  }

  async commit(idempotencyKey: string, result: any): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    this.cache.set(idempotencyKey, { value: result, expiresAt: Date.now() + this.resultTtlMs });
    this.cleanup();
  }

  async release(idempotencyKey: string): Promise<void> {
    const cached = await this.peek(idempotencyKey);
    if (cached?.status === "working") {
      this.cache.delete(idempotencyKey);
    }
  }

  async extendWorking(idempotencyKey: string): Promise<void> {
    const cached = await this.peek(idempotencyKey);
    if (cached?.status === "working") {
      this.cache.set(idempotencyKey, { value: cached, expiresAt: Date.now() + this.workingTtlMs });
    }
  }
}

class RedisIdempotencyManager implements IIdempotencyManager {
  private redis: Redis;
  private readonly resultTtlSeconds = ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS;
  private readonly workingTtlSeconds = ENV.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS;

  constructor() {
    this.redis = getRedisClient();
  }

  generateKey(tenantId: string, toolName: string, args: unknown, owner = "anonymous"): string {
    assertJsonSerializable(args);
    const payload = deterministicStringify({ tenantId, toolName, owner, args });
    const hash = createHash("sha256").update(payload).digest("hex");
    return makeKey(hash);
  }

  isValidKey(idempotencyKey: string): boolean {
    return idempotencyKey.startsWith(keyPrefix()) && /^[a-f0-9]{64}$/.test(idempotencyKey.slice(keyPrefix().length));
  }

  async peek(idempotencyKey: string): Promise<any | null> {
    if (!this.isValidKey(idempotencyKey)) return null;
    const raw = await this.redis.get(idempotencyKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async tryAcquireOrGetCached(idempotencyKey: string): Promise<{ locked: boolean; cached?: any }> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if existing then
        return existing
      end
      redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
      return nil
    `;
    const result = await this.redis.eval(script, 1, idempotencyKey, this.workingTtlSeconds, JSON.stringify(workingRecord()));
    
    if (result === null) {
      return { locked: true };
    }
    
    try {
      return { locked: false, cached: JSON.parse(result as string) };
    } catch {
      return { locked: false, cached: null };
    }
  }

  async commit(idempotencyKey: string, result: any): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) throw new Error("Invalid idempotency key format");
    await this.redis.setex(idempotencyKey, this.resultTtlSeconds, JSON.stringify(result));
  }

  async release(idempotencyKey: string): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) return;
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if not existing then return 0 end
      local decoded = cjson.decode(existing)
      if decoded['status'] == 'working' then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await this.redis.eval(script, 1, idempotencyKey);
  }

  async extendWorking(idempotencyKey: string): Promise<void> {
    if (!this.isValidKey(idempotencyKey)) return;
    const script = `
      local existing = redis.call('GET', KEYS[1])
      if not existing then return 0 end
      local decoded = cjson.decode(existing)
      if decoded['status'] == 'working' then
        return redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return 0
    `;
    await this.redis.eval(script, 1, idempotencyKey, this.workingTtlSeconds);
  }

  async close(): Promise<void> {}
}

export const globalIdempotencyManager: IIdempotencyManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisIdempotencyManager()
  : new MemoryIdempotencyManager();
