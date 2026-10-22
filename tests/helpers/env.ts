export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PORT: "3000",
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    DATABASE_URL: "Server=127.0.0.1;Database=test;",
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
    ...overrides,
  };
}
