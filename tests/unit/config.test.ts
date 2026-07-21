import { describe, expect, it } from "vitest";
import { loadConfig, redactConfig } from "../../src/config/index.js";

describe("config", () => {
  it("loads valid test configuration without exposing secrets", () => {
    const config = loadConfig({
      PORT: "3000",
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "http://localhost:3000",
      DATABASE_URL: "Server=localhost;Database=test;",
      WHATSAPP_PHONE_NUMBER_ID: "123",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "456",
      WHATSAPP_ACCESS_TOKEN: "token-value",
      WHATSAPP_APP_SECRET: "secret-value",
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
      WHATSAPP_TEMPLATE_NAME: "manatee_invite",
      ELEVENLABS_API_KEY: "eleven-key",
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      TILE_HMAC_KEY: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      LOOKUP_HMAC_KEY: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });

    const redacted = redactConfig(config);
    expect(redacted.databaseUrl).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("token-value");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("eleven-key");
  });
});
