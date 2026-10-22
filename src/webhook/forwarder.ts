import { isIP } from "node:net";
import { safeEqualText } from "../utils/crypto.js";

export type WebhookForwarder =
  | { mode: "off" }
  | { mode: "ip"; ips: string[] }
  | { mode: "header"; name: string; value: string };

const DISABLED = new Set(["", "off", "false", "0", "no"]);

/** Strip an IPv4-mapped IPv6 prefix so `::ffff:127.0.0.1` matches `127.0.0.1`. */
export function normalizeIp(value: string): string | null {
  let text = value.trim().toLowerCase();
  if (text.startsWith("::ffff:")) {
    text = text.slice("::ffff:".length);
  }
  if (isIP(text) === 0) {
    return null;
  }
  return text;
}

/**
 * `WHATSAPP_WEBHOOK_FORWARDER` is off unless it names the forwarder's TCP address
 * or a shared header. The header value is a secret and must not be logged.
 */
export function parseWebhookForwarder(raw: string | undefined): WebhookForwarder {
  const text = raw?.trim() ?? "";
  if (DISABLED.has(text.toLowerCase())) {
    return { mode: "off" };
  }

  if (text.toLowerCase().startsWith("header:")) {
    const rest = text.slice("header:".length);
    const splitAt = rest.indexOf(":");
    if (splitAt <= 0 || splitAt >= rest.length - 1) {
      throw new Error("use header:Name:value or a comma-separated IP list");
    }
    const name = rest.slice(0, splitAt).trim();
    const value = rest.slice(splitAt + 1);
    if (!/^[A-Za-z0-9-]+$/.test(name) || value.length === 0 || /[\r\n]/.test(value)) {
      throw new Error("use header:Name:value or a comma-separated IP list");
    }
    return { mode: "header", name, value };
  }

  const ips: string[] = [];
  for (const part of text.split(",")) {
    if (!part.trim()) {
      continue;
    }
    const ip = normalizeIp(part);
    if (!ip) {
      throw new Error("use header:Name:value or a comma-separated IP list");
    }
    if (!ips.includes(ip)) {
      ips.push(ip);
    }
  }
  if (ips.length === 0) {
    throw new Error("use header:Name:value or a comma-separated IP list");
  }
  return { mode: "ip", ips };
}

/**
 * IP mode compares the TCP peer only. `X-Forwarded-For` is not trusted.
 * Header mode compares the configured header in constant time.
 */
export function isForwarderRequestAllowed(
  forwarder: WebhookForwarder,
  remoteAddress: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (forwarder.mode === "off") {
    return true;
  }
  if (forwarder.mode === "ip") {
    const peer = remoteAddress ? normalizeIp(remoteAddress) : null;
    return peer !== null && forwarder.ips.includes(peer);
  }
  return typeof headerValue === "string" && safeEqualText(headerValue, forwarder.value);
}
