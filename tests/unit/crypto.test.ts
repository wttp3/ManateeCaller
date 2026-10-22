import { describe, expect, it } from "vitest";
import { safeEqualText } from "../../src/utils/crypto.js";

describe("safeEqualText", () => {
  it("compares equal strings and unequal strings of different lengths", () => {
    expect(safeEqualText("admin-token", "admin-token")).toBe(true);
    expect(safeEqualText("", "")).toBe(true);
    expect(safeEqualText("a", "ab")).toBe(false);
    expect(safeEqualText("short", "a-much-longer-token")).toBe(false);
    expect(safeEqualText("admin-token", "admin-token ")).toBe(false);
  });
});
