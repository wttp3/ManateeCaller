import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

describe("webhook idempotency fixture", () => {
  it("builds deterministic event keys from synthetic payloads", () => {
    const message = { id: "wamid.test123", from: "447700900000", type: "text", text: { body: "I'm in" } };
    const eventKey = `msg:${message.id}`;
    expect(eventKey).toBe("msg:wamid.test123");
  });

  it("validates synthetic signature format", () => {
    const secret = "synthetic-app-secret";
    const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(sig.startsWith("sha256=")).toBe(true);
  });
});
