import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { WhatsAppService } from "../../src/services/whatsapp.service.js";
import type { AppConfig } from "../../src/config/index.js";

const testConfig = {
  whatsappAppSecret: "test-app-secret",
} as AppConfig;

describe("WhatsApp webhook signature", () => {
  it("validates sha256 signatures", () => {
    const service = new WhatsAppService(testConfig);
    const body = Buffer.from('{"entry":[]}');
    const digest = createHmac("sha256", "test-app-secret").update(body).digest("hex");
    expect(service.verifySignature(body, `sha256=${digest}`)).toBe(true);
    expect(service.verifySignature(body, "sha256=invalid")).toBe(false);
  });
});
