import { config } from "dotenv";
import { z } from "zod";

// Load .env without printing to stdout. Stdio MCP transports reserve stdout for protocol frames only.
config({ quiet: true });

const EnvSchema = z.object({
  STORAGE_DRIVER: z.enum(["fs", "redis", "memory"]).default("fs"),
  TELEMETRY_DRIVER: z.enum(["file", "stdout", "stderr"]).default("file"),
  TRANSPORT_DRIVER: z.enum(["stdio", "http"]).default("stdio"),
  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.number().int().min(1).max(65535).default(3333),
  MCP_AUTH_MODE: z.enum(["api_key", "jwt"]).default("api_key"),
  MCP_API_KEY: z.string().min(32).optional(),
  MCP_JWT_SECRET: z.string().min(32).optional(),
  MCP_JWT_ISSUER: z.string().optional(),
  MCP_JWT_AUDIENCE: z.string().optional(),
  MCP_RESOURCE_URI: z.string().optional(),
  MCP_AUTHORIZATION_SERVERS: z.string().default(""),
  ALLOWED_ORIGINS: z.string().default(""),
  ALLOWED_HOSTS: z.string().default(""),

  REDIS_URL: z.string().optional(),

  ENABLE_RATE_LIMIT: z.boolean().default(false),
  RATE_LIMIT_MAX_REQUESTS: z.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_MS: z.number().int().min(100).default(60000),

  ENABLE_QUOTA: z.boolean().default(false),
  QUOTA_DAILY_LIMIT: z.number().int().min(1).default(1000),

  MCP_ENCRYPTION_KEY: z.string().optional(),
  MCP_ALLOW_LEGACY_SHA256_KDF: z.boolean().default(false),
  MCP_SAFE_MODE: z.boolean().default(true),
  MCP_PROJECT_ID: z.string().default("super_mcp_default"),
  MCP_TENANT_ID: z.string().default("tenant_local"),
  MCP_TRUST_IDENTITY_HEADERS: z.boolean().default(false),

  MCP_PLUGIN_ALLOWLIST: z.string().default("system.tool.js,system.tool.ts"),
  MCP_PLUGIN_AUTO_DISCOVERY: z.boolean().default(false),
  MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY: z.boolean().default(false),
  MCP_PLUGIN_SHA256_ALLOWLIST: z.string().default(""),
  MCP_PLUGIN_ISOLATION_MODE: z.enum(["policy", "external"]).default("policy"),
  MCP_PLUGIN_PIN_MANIFEST: z.boolean().default(true),

  MCP_SECRET_ALLOWLIST: z.string().default(""),
  MCP_ALLOW_SECRET_WRITE: z.boolean().default(false),

  MCP_TOOL_TIMEOUT_MS: z.number().int().min(1000).max(3600000).default(300000),
  MCP_LOCK_TTL_MS: z.number().int().min(5000).max(3600000).default(420000),
  MCP_IDEMPOTENCY_WORKING_TTL_SECONDS: z.number().int().min(30).max(86400).default(600),
  MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: z.number().int().min(60).max(2592000),
  MCP_REDIS_MAX_BACKUPS: z.number().int().min(1).max(1000).default(25),
  MCP_HTTP_BODY_LIMIT: z.string().default("100kb"),
  MCP_TELEMETRY_MAX_BYTES: z.number().int().min(1024).default(1024 * 1024),
  MCP_TELEMETRY_MAX_BACKUPS: z.number().int().min(1).max(100).default(5),
});

const DEV_ENCRYPTION_KEYS = new Set([
  "super_secret_key_for_dev_only",
  "changeme",
  "change_me",
  "dev",
  "development",
]);

function parseSafeBoolean(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(val);
}

function parseIntEnv(val: string | undefined): number | undefined {
  if (val === undefined || val.trim() === "") return undefined;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(raw: string): string[] {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function loadEnv() {
  const storageDriver = process.env.STORAGE_DRIVER || "fs";
  const rawEnv = {
    STORAGE_DRIVER: process.env.STORAGE_DRIVER,
    TELEMETRY_DRIVER: process.env.TELEMETRY_DRIVER || ((process.env.TRANSPORT_DRIVER || "stdio") === "stdio" ? "stderr" : undefined),
    TRANSPORT_DRIVER: process.env.TRANSPORT_DRIVER,
    HTTP_HOST: process.env.HTTP_HOST,
    HTTP_PORT: parseIntEnv(process.env.HTTP_PORT),
    MCP_AUTH_MODE: process.env.MCP_AUTH_MODE,
    MCP_API_KEY: process.env.MCP_API_KEY,
    MCP_JWT_SECRET: process.env.MCP_JWT_SECRET,
    MCP_JWT_ISSUER: process.env.MCP_JWT_ISSUER,
    MCP_JWT_AUDIENCE: process.env.MCP_JWT_AUDIENCE,
    MCP_RESOURCE_URI: process.env.MCP_RESOURCE_URI,
    MCP_AUTHORIZATION_SERVERS: process.env.MCP_AUTHORIZATION_SERVERS,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
    REDIS_URL: process.env.REDIS_URL,
    ENABLE_RATE_LIMIT: parseSafeBoolean(process.env.ENABLE_RATE_LIMIT),
    RATE_LIMIT_MAX_REQUESTS: parseIntEnv(process.env.RATE_LIMIT_MAX_REQUESTS),
    RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS),
    ENABLE_QUOTA: parseSafeBoolean(process.env.ENABLE_QUOTA),
    QUOTA_DAILY_LIMIT: parseIntEnv(process.env.QUOTA_DAILY_LIMIT),
    MCP_ENCRYPTION_KEY: process.env.MCP_ENCRYPTION_KEY,
    MCP_ALLOW_LEGACY_SHA256_KDF: parseSafeBoolean(process.env.MCP_ALLOW_LEGACY_SHA256_KDF),
    MCP_SAFE_MODE: parseSafeBoolean(process.env.MCP_SAFE_MODE),
    MCP_PROJECT_ID: process.env.MCP_PROJECT_ID,
    MCP_TENANT_ID: process.env.MCP_TENANT_ID,
    MCP_TRUST_IDENTITY_HEADERS: parseSafeBoolean(process.env.MCP_TRUST_IDENTITY_HEADERS),
    MCP_PLUGIN_ALLOWLIST: process.env.MCP_PLUGIN_ALLOWLIST,
    MCP_PLUGIN_AUTO_DISCOVERY: parseSafeBoolean(process.env.MCP_PLUGIN_AUTO_DISCOVERY),
    MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY: parseSafeBoolean(process.env.MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY),
    MCP_PLUGIN_SHA256_ALLOWLIST: process.env.MCP_PLUGIN_SHA256_ALLOWLIST,
    MCP_PLUGIN_ISOLATION_MODE: process.env.MCP_PLUGIN_ISOLATION_MODE,
    MCP_PLUGIN_PIN_MANIFEST: parseSafeBoolean(process.env.MCP_PLUGIN_PIN_MANIFEST),
    MCP_SECRET_ALLOWLIST: process.env.MCP_SECRET_ALLOWLIST,
    MCP_ALLOW_SECRET_WRITE: parseSafeBoolean(process.env.MCP_ALLOW_SECRET_WRITE),
    MCP_TOOL_TIMEOUT_MS: parseIntEnv(process.env.MCP_TOOL_TIMEOUT_MS),
    MCP_LOCK_TTL_MS: parseIntEnv(process.env.MCP_LOCK_TTL_MS),
    MCP_IDEMPOTENCY_WORKING_TTL_SECONDS: parseIntEnv(process.env.MCP_IDEMPOTENCY_WORKING_TTL_SECONDS),
    MCP_IDEMPOTENCY_RESULT_TTL_SECONDS: parseIntEnv(process.env.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS) ?? (storageDriver === "redis" ? 604800 : 3600),
    MCP_REDIS_MAX_BACKUPS: parseIntEnv(process.env.MCP_REDIS_MAX_BACKUPS),
    MCP_HTTP_BODY_LIMIT: process.env.MCP_HTTP_BODY_LIMIT,
    MCP_TELEMETRY_MAX_BYTES: parseIntEnv(process.env.MCP_TELEMETRY_MAX_BYTES),
    MCP_TELEMETRY_MAX_BACKUPS: parseIntEnv(process.env.MCP_TELEMETRY_MAX_BACKUPS),
  };

  const parsed = EnvSchema.safeParse(rawEnv);
  
  if (!parsed.success) {
    console.error("FATAL: Invalid Environment Variables Configuration:", parsed.error.format());
    process.exit(1);
  }

  const env = parsed.data;

  if (env.STORAGE_DRIVER === "redis" && !env.REDIS_URL) {
    console.error("FATAL: REDIS_URL environment variable is required when STORAGE_DRIVER=redis");
    process.exit(1);
  }

  if (env.STORAGE_DRIVER === "redis" && !env.MCP_ENCRYPTION_KEY) {
    console.error("FATAL: MCP_ENCRYPTION_KEY is required when STORAGE_DRIVER=redis");
    process.exit(1);
  }

  if (env.STORAGE_DRIVER !== "redis" && env.MCP_IDEMPOTENCY_RESULT_TTL_SECONDS > 3600) {
    console.error("FATAL: MCP_IDEMPOTENCY_RESULT_TTL_SECONDS must be <= 3600 when STORAGE_DRIVER is fs or memory. Use STORAGE_DRIVER=redis for long-lived idempotency.");
    process.exit(1);
  }

  if (env.TRANSPORT_DRIVER === "stdio" && env.TELEMETRY_DRIVER === "stdout") {
    console.error("FATAL: TELEMETRY_DRIVER=stdout is not allowed with TRANSPORT_DRIVER=stdio because stdout is reserved for MCP protocol frames. Use file or stderr.");
    process.exit(1);
  }

  if (env.TRANSPORT_DRIVER === "http") {
    if (env.MCP_AUTH_MODE === "api_key" && (!env.MCP_API_KEY || env.MCP_API_KEY.trim().length < 32)) {
      console.error("FATAL: MCP_API_KEY is required when TRANSPORT_DRIVER=http");
      process.exit(1);
    }

    if (env.MCP_AUTH_MODE === "jwt" && (!env.MCP_JWT_SECRET || env.MCP_JWT_SECRET.trim().length < 32)) {
      console.error("FATAL: MCP_JWT_SECRET is required when TRANSPORT_DRIVER=http and MCP_AUTH_MODE=jwt");
      process.exit(1);
    }

    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    if (env.ALLOWED_ORIGINS === "*" || allowedOrigins.length === 0) {
      console.error("FATAL: ALLOWED_ORIGINS must be an explicit comma-separated allowlist when TRANSPORT_DRIVER=http");
      process.exit(1);
    }

    const allowedHosts = parseList(env.ALLOWED_HOSTS);
    if (env.ALLOWED_HOSTS === "*" || allowedHosts.length === 0) {
      console.error("FATAL: ALLOWED_HOSTS must be an explicit comma-separated allowlist when TRANSPORT_DRIVER=http");
      process.exit(1);
    }
  }

  if (
    env.MCP_ENCRYPTION_KEY &&
    DEV_ENCRYPTION_KEYS.has(env.MCP_ENCRYPTION_KEY.toLowerCase())
  ) {
    console.error("FATAL: MCP_ENCRYPTION_KEY uses a known development value. Generate a unique production secret.");
    process.exit(1);
  }

  if (env.MCP_PLUGIN_AUTO_DISCOVERY && !env.MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY) {
    console.error("FATAL: MCP_PLUGIN_AUTO_DISCOVERY is disabled by default for production safety. Set MCP_ALLOW_UNSAFE_PLUGIN_AUTO_DISCOVERY=true only for trusted local development, or use MCP_PLUGIN_ALLOWLIST.");
    process.exit(1);
  }

  if (env.MCP_PLUGIN_ISOLATION_MODE === "external") {
    console.error("FATAL: MCP_PLUGIN_ISOLATION_MODE=external requires a separate worker/container runner, which is not implemented in this boilerplate. Use policy mode only for trusted plugins.");
    process.exit(1);
  }

  return env;
}

export const ENV = loadEnv();
