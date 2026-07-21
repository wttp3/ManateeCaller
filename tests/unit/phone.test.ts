import { describe, expect, it } from "vitest";
import { isValidE164, normalizePhone } from "../../src/utils/phone.js";

describe("phone utils", () => {
  it("normalizes UK local numbers to E.164", () => {
    expect(normalizePhone("07123456789")).toBe("+447123456789");
  });

  it("accepts valid E.164 numbers", () => {
    expect(isValidE164("+447123456789")).toBe(true);
    expect(isValidE164("447123456789")).toBe(false);
  });
});
