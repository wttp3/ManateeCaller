import { describe, expect, it } from "vitest";
import { isValidE164, normalizePhone } from "../../src/utils/phone.js";

describe("phone utils", () => {
  it("normalizes UK local numbers to E.164", () => {
    expect(normalizePhone("07123456789")).toBe("+447123456789");
  });

  it("strips a parenthesised trunk 0 and a trunk 0 after the country code", () => {
    expect(normalizePhone("+44 (0) 7700 900000")).toBe("+447700900000");
    expect(normalizePhone("+4407700900000")).toBe("+447700900000");
    expect(normalizePhone("0044 (0) 7700 900000")).toBe("+447700900000");
    expect(normalizePhone("+49 (0) 15123456789")).toBe("+4915123456789");
    expect(normalizePhone("+33 (0) 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("+49 0 15123456789")).toBe("+4915123456789");
  });

  it("accepts valid E.164 numbers and rejects a trunk 0 left after the country code", () => {
    expect(isValidE164("+447123456789")).toBe(true);
    expect(isValidE164("+447700900000")).toBe(true);
    expect(isValidE164("+14155552671")).toBe(true);
    expect(isValidE164("+390612345678")).toBe(true);
    expect(isValidE164("447123456789")).toBe(false);
    expect(isValidE164("+4407700900000")).toBe(false);
    expect(isValidE164("+9995551234")).toBe(false);
    expect(isValidE164("+0123456789")).toBe(false);
  });
});
