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
    expect(service.verifySignature(body, `sha256=${digest.toUpperCase()}`)).toBe(true);
    expect(service.verifySignature(body, "sha256=invalid")).toBe(false);
    expect(service.verifySignature(body, undefined)).toBe(false);
    expect(service.verifySignature(body, "")).toBe(false);
    expect(service.verifySignature(body, "sha256=")).toBe(false);
  });

  it("rejects a signature over re-encoded bytes", () => {
    const service = new WhatsAppService(testConfig);
    const raw = Buffer.from('{"entry":[]} \n');
    const reencoded = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
    const digest = createHmac("sha256", "test-app-secret").update(raw).digest("hex");
    expect(service.verifySignature(raw, `sha256=${digest}`)).toBe(true);
    expect(service.verifySignature(reencoded, `sha256=${digest}`)).toBe(false);
  });
});
