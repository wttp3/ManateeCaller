import { describe, expect, it } from "vitest";
import { PROMPTS } from "../../src/interview/constants.js";
import { expiredNoticeBody, isServiceWindowOpen } from "../../src/interview/service-window.js";

describe("service window", () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");

  it("is open only before the stored expiry", () => {
    expect(isServiceWindowOpen(new Date(now + 1000), now)).toBe(true);
    expect(isServiceWindowOpen(new Date(now), now)).toBe(false);
    expect(isServiceWindowOpen(new Date(now - 1), now)).toBe(false);
    expect(isServiceWindowOpen(null, now)).toBe(false);
  });

  it("keeps the expired prompt only while a free-form send is still legal", () => {
    expect(expiredNoticeBody(new Date(now + 1000), now)).toBe(PROMPTS.expired);
    expect(expiredNoticeBody(new Date(now - 1), now)).toBeNull();
    expect(expiredNoticeBody(null, now)).toBeNull();
  });
});
