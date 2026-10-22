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
      DATA_ENCRYPTION_KEY: "ab".repeat(32),
      TILE_HMAC_KEY: "cd".repeat(32),
      LOOKUP_HMAC_KEY: "ef".repeat(32),
    });

    const redacted = redactConfig(config);
    expect(redacted.databaseUrl).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("token-value");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("eleven-key");
    expect(config.whatsappTemplateInvitesEnabled).toBe(false);
    expect(config.optInKeyword).toBe("I'm in");
    expect(config.pilotAllowedSenders).toEqual([]);
    expect(redacted.whatsappTemplateInvitesEnabled).toBe(false);
    expect(redacted.pilotAllowedSenderCount).toBe(0);
  });

  it("parses the pilot allowlist and keeps numbers out of the redacted view", () => {
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
      DATA_ENCRYPTION_KEY: "ab".repeat(32),
      TILE_HMAC_KEY: "cd".repeat(32),
      LOOKUP_HMAC_KEY: "ef".repeat(32),
      PILOT_ALLOWED_SENDERS: "+447700900000, +14155552671, +447700900000",
      OPT_IN_KEYWORD: "count me in",
      WHATSAPP_TEMPLATE_INVITES_ENABLED: "true",
    });

    expect(config.pilotAllowedSenders).toEqual(["+447700900000", "+14155552671"]);
    expect(config.optInKeyword).toBe("count me in");
    expect(config.whatsappTemplateInvitesEnabled).toBe(true);
    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain("+447700900000");
    expect(redacted).not.toContain("+14155552671");
    expect(redactConfig(config).pilotAllowedSenderCount).toBe(2);
  });

  it("rejects an allowlist entry that is not E.164", () => {
    expect(() =>
      loadConfig({
        PORT: "3000",
        PUBLIC_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "Server=localhost;Database=test;",
        WHATSAPP_PHONE_NUMBER_ID: "123",
        WHATSAPP_BUSINESS_ACCOUNT_ID: "456",
        WHATSAPP_ACCESS_TOKEN: "token-value",
        WHATSAPP_APP_SECRET: "secret-value",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
        WHATSAPP_TEMPLATE_NAME: "manatee_invite",
        ELEVENLABS_API_KEY: "eleven-key",
        DATA_ENCRYPTION_KEY: "ab".repeat(32),
        TILE_HMAC_KEY: "cd".repeat(32),
        LOOKUP_HMAC_KEY: "ef".repeat(32),
        PILOT_ALLOWED_SENDERS: "07700900000",
      }),
    ).toThrow(/pilotAllowedSenders/);
  });
});
