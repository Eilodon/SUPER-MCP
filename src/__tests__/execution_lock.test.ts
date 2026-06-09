import { describe, expect, test, vi } from "vitest";
import { RedisExecutionLockManager } from "../middlewares/execution_lock.js";

describe("RedisExecutionLockManager", () => {
  test("acquires lock and executes operation", async () => {
    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    } as any;
    const manager = new RedisExecutionLockManager(fakeRedis);
    const result = await manager.withTenantLock("tenant-1", async (signal) => {
      return "done";
    });
    expect(result).toBe("done");
    expect(fakeRedis.set).toHaveBeenCalled();
  });
});
