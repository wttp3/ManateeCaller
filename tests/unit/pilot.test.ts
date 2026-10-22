import { describe, expect, it } from "vitest";
import {
  isPilotSenderAllowed,
  maskPhone,
  parsePilotAllowlist,
} from "../../src/pilot/allowlist.js";
import { isOptInMessage } from "../../src/pilot/opt-in.js";

describe("pilot allowlist", () => {
  it("parses comma-separated E.164 numbers and ignores blanks", () => {
    expect(parsePilotAllowlist(" +447700900000, +1 415 555 2671, ")).toEqual([
      "+447700900000",
      "+14155552671",
    ]);
    expect(parsePilotAllowlist(undefined)).toEqual([]);
    expect(parsePilotAllowlist("")).toEqual([]);
  });

  it("rejects numbers that are not already E.164", () => {
    expect(() => parsePilotAllowlist("447700900000")).toThrow(/E\.164/);
    expect(() => parsePilotAllowlist("+123")).toThrow(/E\.164/);
    expect(() => parsePilotAllowlist("+447700900000,07700900000")).toThrow(/E\.164/);
  });

  it("matches inbound digits against the E.164 list and fails closed", () => {
    const allowlist = ["+447700900000"];
    expect(isPilotSenderAllowed("447700900000", allowlist)).toBe(true);
    expect(isPilotSenderAllowed("+447700900000", allowlist)).toBe(true);
    expect(isPilotSenderAllowed("+14155552671", allowlist)).toBe(false);
    expect(isPilotSenderAllowed("+447700900000", [])).toBe(false);
    expect(isPilotSenderAllowed("not-a-number", allowlist)).toBe(false);
  });

  it("treats a trunk-zero allowlist entry as the same number as inbound digits", () => {
    const allowlist = parsePilotAllowlist("+44 (0) 7700 900000");
    expect(allowlist).toEqual(["+447700900000"]);
    expect(isPilotSenderAllowed("447700900000", allowlist)).toBe(true);
    expect(isPilotSenderAllowed("+44 0 7700 900000", allowlist)).toBe(true);
  });

  it("masks numbers so logs do not contain the full digit string", () => {
    const raw = "+447700900000";
    const masked = maskPhone(raw);
    expect(masked).toBe("+44••••••0000");
    expect(masked).not.toContain("447700900000");
    expect(maskPhone("+14155552671")).toBe("+14•••••2671");
    expect(maskPhone("123")).toBe("••••");
  });
});

describe("opt-in keyword", () => {
  it("matches the default keyword case-insensitively, including a curly apostrophe", () => {
    expect(isOptInMessage({ text: " I'm in " }, "I'm in")).toBe(true);
    expect(isOptInMessage({ text: "I'M IN" }, "I'm in")).toBe(true);
    expect(isOptInMessage({ text: "I’m in" }, "I'm in")).toBe(true);
    expect(isOptInMessage({ text: "hello" }, "I'm in")).toBe(false);
  });

  it("uses the configured keyword and accepts the template button only for an existing participant", () => {
    expect(isOptInMessage({ text: "Count   me in" }, "count me in")).toBe(true);
    expect(isOptInMessage({ text: "I'm in" }, "count me in")).toBe(false);
    expect(isOptInMessage({ buttonReplyId: "IM_IN" }, "count me in")).toBe(false);
    expect(
      isOptInMessage({ buttonReplyId: "IM_IN" }, "count me in", {
        templateInvitesEnabled: true,
        participantExists: false,
      }),
    ).toBe(false);
    expect(
      isOptInMessage({ buttonReplyId: "IM_IN" }, "count me in", {
        templateInvitesEnabled: false,
        participantExists: true,
      }),
    ).toBe(false);
    expect(
      isOptInMessage({ buttonReplyId: "IM_IN" }, "count me in", {
        templateInvitesEnabled: true,
        participantExists: true,
      }),
    ).toBe(true);
  });
});
