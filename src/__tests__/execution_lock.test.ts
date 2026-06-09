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

  test("rejects immediately when heartbeat loses the lock", async () => {
    vi.useFakeTimers();

    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValue(0),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis);

    const promise = manager.withTenantLock("tenant-1", async (signal) => {
      await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
      await new Promise(() => undefined);
    });

    const expectPromise = expect(promise).rejects.toThrow(/lock was lost/);

    await vi.advanceTimersByTimeAsync(140000);

    await expectPromise;
    vi.useRealTimers();
  });

  test("rejects after two consecutive heartbeat errors", async () => {
    vi.useFakeTimers();

    const fakeRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn()
        .mockRejectedValueOnce(new Error("redis down"))
        .mockRejectedValueOnce(new Error("redis still down"))
        .mockResolvedValue(1),
    } as any;

    const manager = new RedisExecutionLockManager(fakeRedis);

    const promise = manager.withTenantLock("tenant-1", async () => {
      await new Promise(() => undefined);
    });

    const expectPromise = expect(promise).rejects.toThrow(/heartbeat failed repeatedly/);

    await vi.advanceTimersByTimeAsync(280000);

    await expectPromise;
    vi.useRealTimers();
  });
});
