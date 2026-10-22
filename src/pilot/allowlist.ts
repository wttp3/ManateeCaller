import { isValidE164, normalizePhone } from "../utils/phone.js";

export const INBOUND_IGNORED_MESSAGE =
  "Ignoring inbound WhatsApp message from a number outside the pilot allowlist";

export const OUTBOUND_REFUSED_MESSAGE =
  "Refusing outbound WhatsApp send to a number outside the pilot allowlist";

const NEGATIVE_FLAGS = new Set(["0", "false", "no", "off"]);

/** True when an operator flag is present and not an explicit negative. */
export function isEnvFlagSet(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || NEGATIVE_FLAGS.has(normalized)) {
    return false;
  }
  return true;
}

/**
 * `PILOT_ALLOWED_SENDERS` is comma-separated E.164. Empty means nobody.
 * Entries must already include the leading + so local-number rewriting cannot widen the list.
 */
export function parsePilotAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  const phones: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }
    if (!token.startsWith("+")) {
      throw new Error("Pilot allowlist entries must be E.164");
    }
    const phone = normalizePhone(token);
    if (!isValidE164(phone)) {
      throw new Error("Pilot allowlist entries must be E.164");
    }
    if (!phones.includes(phone)) {
      phones.push(phone);
    }
  }
  return phones;
}

export function isPilotSenderAllowed(phone: string, allowlist: readonly string[]): boolean {
  const normalized = normalizePhone(phone);
  if (!isValidE164(normalized)) {
    return false;
  }
  return allowlist.includes(normalized);
}

/** Mask for logs. The result is not itself an E.164 number, so it survives log redaction. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) {
    return "••••";
  }
  const head = digits.slice(0, 2);
  const tail = digits.slice(-4);
  const hidden = digits.length - head.length - tail.length;
  return `+${head}${"•".repeat(hidden)}${tail}`;
}

export class PilotSendRefusedError extends Error {
  constructor() {
    super("Outbound send refused: recipient is not on the pilot allowlist");
    this.name = "PilotSendRefusedError";
  }
}

export const OPT_OUT_REFUSED_MESSAGE =
  "Refusing outbound WhatsApp send because the recipient has opted out or is blocked";

export class OptOutSendRefusedError extends Error {
  constructor() {
    super("Outbound send refused: recipient has opted out or is blocked");
    this.name = "OptOutSendRefusedError";
  }
}
