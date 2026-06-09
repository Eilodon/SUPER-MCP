# SUPER-MCP Enterprise Hardening Report

This package includes the second hardening pass applied after the enterprise re-audit.

## Validated commands

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=low
```

All commands passed in the hardening environment. Runtime smoke tests also passed:

- `stdio` mode produced 0 bytes on stdout during bootstrap, preserving MCP protocol framing.
- HTTP mode accepted a real SDK Streamable HTTP client, completed initialize/listTools/callTool, and returned `super_mcp_ping` successfully.

## Major fixes

- Removed dotenv and storage bootstrap stdout pollution in stdio mode.
- Added fatal config guard against `TRANSPORT_DRIVER=stdio` + `TELEMETRY_DRIVER=stdout`.
- Added `stderr` telemetry driver for stdio-safe JSONL diagnostics.
- Fixed HTTP Streamable transport handling by using per-request stateless transports and passing `req.body`.
- Added Host allowlist validation and required `ALLOWED_HOSTS` in HTTP mode.
- Kept explicit CORS allowlist and API-key-only `x-api-key` auth.
- Added request context via AsyncLocalStorage with tenant/user/client/request metadata.
- Ignored tenant identity headers by default unless `MCP_TRUST_IDENTITY_HEADERS=true` is set behind a trusted gateway.
- Refactored runtime state handling to per-tenant state loading and saving.
- Added state `revision` and Redis revision compare-and-set guard.
- Added Redis-backed tenant execution locks with heartbeat and safe token release.
- Fixed Redis rate-limit member collision by using unique ZSET members.
- Fixed Redis quota check to avoid incrementing denied requests.
- Added idempotency TTLs for memory mode, key validation, and working lock heartbeat extension.
- Disabled unsafe plugin auto-discovery by default; added plugin allowlist and optional SHA-256 allowlist.
- Added tool capability declarations and Safe Mode enforcement for risky capabilities.
- Hardened vault key validation, context-scoped Redis vault keys, secret allowlist support, and disabled secret writes by default.
- Added telemetry string-value redaction for bearer tokens, Redis credentials, query credentials, and high-risk fields.
- Hardened local file permissions for state and telemetry files.
- Hardened Containerfile and compose defaults: pinned pnpm, production prune, non-root runtime, no public port mapping, dropped capabilities, no-new-privileges, read-only MCP service filesystem.

## Remaining enterprise notes

- Static shared API key remains a bootstrap auth mechanism. For regulated cloud deployment, put this service behind mTLS/OIDC/JWT-aware ingress and enable trusted identity headers only from that gateway.
- Plugin sandboxing is policy-based in-process hardening, not an OS sandbox. Untrusted third-party plugins should run in isolated workers/containers.
- Redis encryption is application-level encryption; enterprise deployments should prefer KMS/secret-manager backed envelope encryption.

## V2 follow-up hardening pass

This package also includes an additional remediation pass for the verified audit findings:

- Replaced single-step SHA-256 key derivation for new encrypted state with a versioned `smcp:v2:scrypt` envelope and per-blob salt.
- Added `base64url:<32-byte-key>` support for deployments that provide a raw data-encryption key.
- Added `MCP_ALLOW_LEGACY_SHA256_KDF`; keep it `false` by default and enable only for a one-time migration read of existing legacy ciphertext.
- Replaced Redis `backup_latest` with revisioned backup keys plus sorted-set rotation controlled by `MCP_REDIS_MAX_BACKUPS`.
- Centralized Redis connection creation through a shared command client.
- Added explicit HTTP JSON body size and content-type handling through `MCP_HTTP_BODY_LIMIT`.
- Applied rate-limit/quota governance to `check_task_status`.
- Added shutdown draining protection for new async tasks.
- Added JSON-serializable validation for idempotency arguments.
- Added optional `payloadSchema` validation for plugin state payload contracts.
- Added `npm run migrate:encryption` for one-tenant legacy SHA-256 ciphertext migration to the v2 envelope. Use `-- --driver fs --tenant <tenant>` or `-- --driver redis --tenant <tenant>`.
- Added `MCP_PLUGIN_ISOLATION_MODE`; `external` currently fails fast because true OS/process isolation requires a separate runner. `policy` mode remains for trusted, allowlisted plugins.
- Added regression coverage for Redis backup rotation through a fake Redis client, HTTP content-type/body-limit helpers, and `check_task_status` governance ordering.

## MCP ecosystem alignment pass

The June 2026 MCP ecosystem review was checked against official MCP sources. The `2026-07-28` release candidate was published on 2026-05-21, while the final specification date is 2026-07-28. The following compatibility improvements were applied:

- Added `annotations` to `ToolDefinition` and forwarded them to `server.registerTool`.
- Added `execution.taskSupport` metadata. Current custom async tools remain `taskSupport: "forbidden"` until native MCP Tasks are implemented end-to-end.
- Annotated system tools:
  - `super_mcp_ping`: read-only, non-destructive, idempotent, closed-world.
  - `check_task_status`: read-only, non-destructive, idempotent, closed-world.
  - `super_mcp_long_task`: non-read-only, non-destructive, non-idempotent, closed-world.
- Added HTTP discovery endpoints:
  - `GET /.well-known/mcp.json` as the canonical Server Card-style endpoint currently described by the transport roadmap.
  - `GET /.well-known/mcp-server-card` as a compatibility alias while Server Cards are still draft/WG-owned.
- Added phase-1 JWT auth mode for HTTP deployments:
  - `MCP_AUTH_MODE=api_key` keeps the existing static API key behavior.
  - `MCP_AUTH_MODE=jwt` validates `Authorization: Bearer <jwt>` using `MCP_JWT_SECRET`, optional `MCP_JWT_ISSUER`, and optional `MCP_JWT_AUDIENCE`.
  - JWT claims can carry `tenant_id`/`mcp_tenant_id`, `sub`, `azp`/`client_id`, and `scope`/`scopes`.
- Added `requiredScopes` to tool definitions and scope enforcement for JWT-authenticated requests.
- Added `GET /.well-known/oauth-protected-resource` metadata for JWT/resource-server deployments, populated from `MCP_RESOURCE_URI`, `MCP_AUTHORIZATION_SERVERS`, and tool `requiredScopes`.
- Added `WWW-Authenticate: Bearer resource_metadata="..."` on JWT auth failures.

Not implemented in this pass:

- Full OAuth 2.1 / OIDC authorization-server discovery and PKCE flow. This requires an authorization server integration and should follow the MCP authorization spec for protected resource metadata.
- Native MCP Tasks (`tasks/get`, `tasks/list`, `tasks/cancel`, task-augmented `tools/call`). The current custom async path remains until the TypeScript SDK and target clients support the selected Tasks version end-to-end.
- MCP Apps and A2A delegation. The current runtime methods are left as future extension points.

Validation note: run `npm install`, `npm run typecheck`, `npm test`, and `npm run build` in an environment that can access the npm registry. The container used for this pass could not complete dependency installation because registry access to `@modelcontextprotocol/sdk` returned `403 Forbidden`.

## HolySeed-pattern review pass

The HolySeed write-up was treated as a design-pattern source, not as externally verified ecosystem guidance. Public searches did not provide enough evidence to validate named mechanisms such as "WASM Forge Scanner", "TraumaRegistry", "CRDT Version Pin ADR-012a", "K1 Kill Switches", or "Constitutional Kernel" as public standards. The useful engineering themes were still applied where they fit SUPER-MCP without a full runtime rewrite:

- Added recursive JSON input sanitization before confidence checks, idempotency-key generation, and tool handler execution. This strips `__proto__`, `constructor`, and `prototype` keys before policy evaluation.
- Added an output firewall after handler execution and before truncation/idempotency commit. It redacts common credentials, private keys, Luhn-valid payment card numbers, SSN-shaped identifiers, and prompt-injection markers, and logs `output_firewall_redacted` telemetry.
- Added plugin startup manifest pinning through `MCP_PLUGIN_PIN_MANIFEST=true` by default. If plugin files change after startup, new invocations fail closed until a deliberate restart accepts the new manifest.
- Hardened the confidence gate so self-reported confidence must include concrete observable safety signals and cannot pass with short generic reassurance such as "trust me" or "this is safe".
- Replaced memory rate-limit timestamp arrays with bounded violation records, severity EMA, and exponential backoff capped at 24 hours.
- Added `docs/pattern-debt-registry.yaml` to track residual enterprise debt with measurable resolution triggers.

Still not implemented:

- WASM/Wasmtime scanning, fuel limits, or OS/container plugin isolation. This requires a separate runner and packaging model.
- Z3-proven kill switches or a formal policy proof system.
- Full CRDT registry pinning. SUPER-MCP now has lightweight plugin manifest pinning and tenant execution locks, not a distributed CRDT control plane.
- Per-user crypto-erasure with KMS-backed DEK deletion.
