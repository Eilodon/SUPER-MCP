import { jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { ENV } from "../config/env.js";
import { resolveHttpRequestContext, resolveJwtRequestContext, type RequestContext } from "./context.js";

function isAuthorizedApiKey(received: unknown): boolean {
  if (typeof received !== "string") return false;
  const expected = Buffer.from(ENV.MCP_API_KEY || "", "utf-8");
  const actual = Buffer.from(received, "utf-8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearerToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1] || null;
}

export async function authenticateHttpRequest(headers: Record<string, string | string[] | undefined>): Promise<RequestContext> {
  if (ENV.MCP_AUTH_MODE === "api_key") {
    if (!isAuthorizedApiKey(headers["x-api-key"])) {
      throw new Error("Unauthorized");
    }
    return resolveHttpRequestContext(headers);
  }

  const token = bearerToken(headers.authorization ?? headers.Authorization);
  if (!token || !ENV.MCP_JWT_SECRET) {
    throw new Error("Unauthorized");
  }

  const secret = new TextEncoder().encode(ENV.MCP_JWT_SECRET);
  const { payload } = await jwtVerify(token, secret, {
    issuer: ENV.MCP_JWT_ISSUER || undefined,
    audience: ENV.MCP_JWT_AUDIENCE || undefined,
  });
  const requestId = Array.isArray(headers["x-request-id"]) ? headers["x-request-id"][0] : headers["x-request-id"];
  return resolveJwtRequestContext(payload as Record<string, unknown>, requestId);
}
