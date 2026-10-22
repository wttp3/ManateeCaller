import { describe, expect, it } from "vitest";
import { isErasureCommand, isStopCommand } from "../../src/pilot/commands.js";

describe("stop and erasure commands", () => {
  it("matches stop variants and ignores case and whitespace", () => {
    for (const text of ["STOP", " stop ", "Stop", "UNSUBSCRIBE", "un-subscribe", "Cancel", "  OPT   OUT ", "opt-out", "optout"]) {
      expect(isStopCommand({ text }), text).toBe(true);
    }
    expect(isStopCommand({ buttonReplyId: "STOP" })).toBe(true);
    expect(isStopCommand({ text: "please stop" })).toBe(false);
    expect(isStopCommand({ text: "I'm in" })).toBe(false);
    expect(isStopCommand({ text: "delete my data" })).toBe(false);
  });

  it("matches a configured erasure keyword and ignores case and whitespace", () => {
    expect(isErasureCommand({ text: "  Delete   MY   data " }, "DELETE MY DATA")).toBe(true);
    expect(isErasureCommand({ text: "delete-my-data" }, "DELETE MY DATA")).toBe(true);
    expect(isErasureCommand({ buttonReplyId: "DELETE MY DATA" }, "delete my data")).toBe(true);
    expect(isErasureCommand({ text: "please delete my data" }, "DELETE MY DATA")).toBe(false);
    expect(isErasureCommand({ text: "STOP" }, "DELETE MY DATA")).toBe(false);
    expect(isErasureCommand({ text: "erase me now" }, "erase me")).toBe(false);
    expect(isErasureCommand({ text: "  erase   me " }, "erase me")).toBe(true);
  });
});
