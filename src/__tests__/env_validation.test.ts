import { afterEach, describe, expect, test, vi } from "vitest";

async function importEnvWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("../config/env.js");
}

describe("env validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("fails fast when non-Redis idempotency result TTL exceeds 1 hour", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(importEnvWith({
      STORAGE_DRIVER: "fs",
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "604800",
    })).rejects.toThrow("process.exit:1");

    expect(exit).toHaveBeenCalledWith(1);
  });

  test("allows long idempotency result TTL with Redis", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mod = await importEnvWith({
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "604800",
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(604800);
  });

  test("defaults telemetry to stderr for stdio when unset", async () => {
    const mod = await importEnvWith({
      TRANSPORT_DRIVER: "stdio",
      TELEMETRY_DRIVER: undefined,
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.TELEMETRY_DRIVER).toBe("stderr");
  });

  test("defaults lock TTL to 420000ms", async () => {
    const mod = await importEnvWith({
      MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: "3600",
    });

    expect(mod.ENV.MCP_LOCK_TTL_MS).toBe(420000);
  });

  test("defaults Redis idempotency result TTL to 7 days", async () => {
    const mod = await importEnvWith({
      STORAGE_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
      MCP_ENCRYPTION_KEY: "x".repeat(32),
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(604800);
  });

  test("defaults non-Redis idempotency result TTL to 1 hour", async () => {
    const mod = await importEnvWith({
      STORAGE_DRIVER: "fs",
    });

    expect(mod.ENV.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS).toBe(3600);
  });
});
