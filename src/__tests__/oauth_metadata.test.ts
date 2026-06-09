import { describe, expect, test } from "vitest";
import { protectedResourceMetadata, resourceMetadataPath } from "../http/oauth_metadata.js";
import type { ToolDefinition } from "../core/registrar.js";

describe("OAuth protected resource metadata", () => {
  test("publishes resource metadata shape and supported scopes", () => {
    const tools: ToolDefinition[] = [
      {
        name: "email_send",
        description: "Send email",
        inputSchema: {},
        allowedPhases: ["execution"],
        requiredScopes: ["email:send"],
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];

    const metadata = protectedResourceMetadata(tools);
    expect(resourceMetadataPath()).toBe("/.well-known/oauth-protected-resource");
    expect(metadata.bearer_methods_supported).toEqual(["header"]);
    expect(metadata.scopes_supported).toEqual(["email:send"]);
  });
});
