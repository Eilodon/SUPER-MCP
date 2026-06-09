import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("registrar system tool governance", () => {
  test("check_task_status applies invocation governance before reading task cache", async () => {
    const source = await readFile(new URL("../core/registrar.ts", import.meta.url), "utf-8");
    const registration = source.slice(source.indexOf('"check_task_status"'));
    expect(registration).toContain('applyInvocationGovernance("check_task_status"');
    expect(registration.indexOf('applyInvocationGovernance("check_task_status"')).toBeLessThan(
      registration.indexOf("globalIdempotencyManager.peek")
    );
  });
});
