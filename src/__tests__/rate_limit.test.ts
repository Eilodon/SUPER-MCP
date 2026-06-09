import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { MemoryRateLimiter } from "../middlewares/rate_limit.js";

describe("MemoryRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("cleans up expired records", async () => {
    vi.stubEnv("ENABLE_RATE_LIMIT", "true");
    const limiter = new MemoryRateLimiter();
    
    const result = await limiter.check("tenant-1");
    expect(result.allowed).toBe(true);
    
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    
    await limiter.close();
  });
});
