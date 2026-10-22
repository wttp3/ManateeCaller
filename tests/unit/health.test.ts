import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";

const previousSha = process.env.DEPLOY_COMMIT_SHA;

function testConfig() {
  return loadConfig({
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
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) {
    return;
  }
  server.close();
  await once(server, "close");
}

afterEach(() => {
  if (previousSha === undefined) {
    delete process.env.DEPLOY_COMMIT_SHA;
  } else {
    process.env.DEPLOY_COMMIT_SHA = previousSha;
  }
});

describe("GET /health", () => {
  it("returns DEPLOY_COMMIT_SHA as sha and omits it when unset", async () => {
    process.env.DEPLOY_COMMIT_SHA = "ci-smoke-sha";
    const app = createApp(testConfig());
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; sha: string | null; config: { databaseUrl: string } };
      expect(body.ok).toBe(true);
      expect(body.sha).toBe("ci-smoke-sha");
      expect(body.config.databaseUrl).toBe("[redacted]");
      expect(JSON.stringify(body)).not.toContain("token-value");

      delete process.env.DEPLOY_COMMIT_SHA;
      const missing = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { sha: string | null };
      expect(missing.sha).toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
