import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { ENV } from "../config/env.js";
import { getRedisClient } from "../storage/redis_client.js";

export interface IExecutionLockManager {
  withTenantLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const localQueues = new Map<string, Promise<unknown>>();

async function enqueueLocal<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(tenantId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  localQueues.set(tenantId, next);
  try {
    return await next;
  } finally {
    if (localQueues.get(tenantId) === next) {
      localQueues.delete(tenantId);
    }
  }
}

class MemoryExecutionLockManager implements IExecutionLockManager {
  async withTenantLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return enqueueLocal(tenantId, operation);
  }
}

class RedisExecutionLockManager implements IExecutionLockManager {
  private redis: Redis;
  private readonly ttlMs = ENV.MCP_LOCK_TTL_MS;

  constructor() {
    this.redis = getRedisClient();
  }

  private getKey(tenantId: string): string {
    return `super_mcp:lock:${ENV.MCP_PROJECT_ID}:${tenantId}`;
  }

  async withTenantLock<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return enqueueLocal(tenantId, async () => {
      const key = this.getKey(tenantId);
      const token = randomUUID();
      const deadline = Date.now() + this.ttlMs;

      while (Date.now() < deadline) {
        const acquired = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
        if (acquired === "OK") {
          let stopped = false;
          const heartbeat = setInterval(() => {
            if (stopped) return;
            const script = `
              if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('PEXPIRE', KEYS[1], ARGV[2])
              end
              return 0
            `;
            this.redis.eval(script, 1, key, token, this.ttlMs).catch(err => {
              console.error("[SUPER-MCP] Failed to refresh tenant execution lock:", err);
            });
          }, Math.max(1000, Math.floor(this.ttlMs / 3)));

          try {
            return await operation();
          } finally {
            stopped = true;
            clearInterval(heartbeat);
            const releaseScript = `
              if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
              end
              return 0
            `;
            await this.redis.eval(releaseScript, 1, key, token).catch(() => undefined);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      throw new Error(`[SUPER-MCP] Could not acquire tenant execution lock for ${tenantId}`);
    });
  }

  async close(): Promise<void> {}
}

export const globalExecutionLockManager: IExecutionLockManager = ENV.STORAGE_DRIVER === "redis"
  ? new RedisExecutionLockManager()
  : new MemoryExecutionLockManager();
