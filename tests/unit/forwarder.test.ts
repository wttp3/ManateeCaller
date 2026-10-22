import { describe, expect, it } from "vitest";
import { isForwarderRequestAllowed, normalizeIp, parseWebhookForwarder } from "../../src/webhook/forwarder.js";

describe("webhook forwarder flag", () => {
  it("is off when unset, empty, or an explicit negative", () => {
    expect(parseWebhookForwarder(undefined)).toEqual({ mode: "off" });
    expect(parseWebhookForwarder("")).toEqual({ mode: "off" });
    expect(parseWebhookForwarder("  off  ")).toEqual({ mode: "off" });
    expect(parseWebhookForwarder("false")).toEqual({ mode: "off" });
  });

  it("parses peer IPs and matches an IPv4-mapped address", () => {
    expect(parseWebhookForwarder("203.0.113.10, 198.51.100.4, 203.0.113.10")).toEqual({
      mode: "ip",
      ips: ["203.0.113.10", "198.51.100.4"],
    });
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    const forwarder = parseWebhookForwarder("127.0.0.1");
    expect(isForwarderRequestAllowed(forwarder, "::ffff:127.0.0.1", undefined)).toBe(true);
    expect(isForwarderRequestAllowed(forwarder, "203.0.113.10", "127.0.0.1")).toBe(false);
    expect(isForwarderRequestAllowed({ mode: "off" }, "203.0.113.10", undefined)).toBe(true);
  });

  it("compares a shared header and rejects a bad flag", () => {
    const forwarder = parseWebhookForwarder("header:X-Webhook-Forwarder:pilot-shared");
    expect(isForwarderRequestAllowed(forwarder, "127.0.0.1", "pilot-shared")).toBe(true);
    expect(isForwarderRequestAllowed(forwarder, "127.0.0.1", "other-value")).toBe(false);
    expect(isForwarderRequestAllowed(forwarder, "127.0.0.1", undefined)).toBe(false);
    expect(() => parseWebhookForwarder("not-an-ip")).toThrow(/IP list/);
    expect(() => parseWebhookForwarder("header:bad")).toThrow(/IP list/);
  });
});
