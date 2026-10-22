import { describe, expect, it } from "vitest";
import { combineTranscripts, normalizeTranscript, transcriptToColor } from "../../src/utils/color.js";

describe("color utils", () => {
  it("normalizes transcript whitespace and case", () => {
    expect(normalizeTranscript("  Hello   World  ")).toBe("hello world");
  });

  it("produces deterministic HMAC colour", () => {
    const tileHmac = "ab".repeat(32);
    const combined = combineTranscripts(["Blue morning", "blue morning"]);
    const color = transcriptToColor(combined, tileHmac);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(transcriptToColor(combined, tileHmac)).toBe(color);
  });
});
