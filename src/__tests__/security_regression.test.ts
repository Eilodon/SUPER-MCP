import { describe, expect, test } from "vitest";
import { redact } from "../telemetry/redaction.js";
import { resolveHttpRequestContext } from "../security/context.js";
import { resolveJwtRequestContext } from "../security/context.js";
import { globalCredentialVault } from "../middlewares/vault.js";
import { EncryptionService } from "../storage/encryption.js";

describe("Enterprise hardening regressions", () => {
  test("telemetry redacts secret-bearing strings, not only secret keys", () => {
    const redacted = redact({
      error: "request failed Authorization=Bearer abc.def.ghi redis://:hunter2@redis:6379 token=supersecret",
      nested: { apiKey: "should-not-leak" },
    }) as any;
    expect(redacted.error).not.toContain("hunter2");
    expect(redacted.error).not.toContain("supersecret");
    expect(redacted.error).toContain("[REDACTED]");
    expect(redacted.nested.apiKey).toBe("[REDACTED]");
  });

  test("identity headers are ignored unless trusted identity headers are explicitly enabled", () => {
    const ctx = resolveHttpRequestContext({
      "x-mcp-tenant-id": "attacker-tenant",
      "x-mcp-user-id": "attacker-user",
      "x-request-id": "req-123",
    });
    expect(ctx.tenantId).toBe("tenant_local");
    expect(ctx.userId).toBe("api-key-user");
    expect(ctx.requestId).toBe("req-123");
  });

  test("vault rejects unsafe secret key names", async () => {
    await expect(globalCredentialVault.getSecret("../../MCP_API_KEY")).rejects.toThrow(/Invalid secret key name/);
  });

  test("encryption uses a versioned v2 envelope and decrypts round-trip", async () => {
    const key = `base64url:${Buffer.alloc(32, 7).toString("base64url")}`;
    const service = new EncryptionService(key);
    const state = { tenantId: "tenant-a", payload: { ok: true } };

    const encrypted = await service.encryptState(state);
    expect(encrypted).toMatch(/^smcp:v2:scrypt:/);
    await expect(service.decryptState(encrypted)).resolves.toEqual(state);
  });

  test("encrypted state does not accept plaintext JSON when a key is configured", async () => {
    const key = `base64url:${Buffer.alloc(32, 9).toString("base64url")}`;
    const service = new EncryptionService(key);

    await expect(service.decryptState(JSON.stringify({ injected: true }))).rejects.toThrow(/Legacy SHA-256 encrypted state detected/);
  });

  test("JWT claims can carry tenant, subject, client, and scopes per request", () => {
    const ctx = resolveJwtRequestContext({
      sub: "user-123",
      azp: "client-abc",
      tenant_id: "tenant-prod",
      scope: "calendar:read email:send",
    }, "req-jwt");

    expect(ctx.authType).toBe("jwt");
    expect(ctx.tenantId).toBe("tenant-prod");
    expect(ctx.userId).toBe("user-123");
    expect(ctx.clientId).toBe("client-abc");
    expect(ctx.scopes).toEqual(["calendar:read", "email:send"]);
  });
});
