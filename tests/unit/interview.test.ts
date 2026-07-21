import { describe, expect, it } from "vitest";
import {
  nextStateAfterOptIn,
  promptForState,
  questionIndexForState,
  stateAfterIntroSent,
  stateAfterVoiceAnswer,
} from "../../src/interview/constants.js";

describe("interview state machine", () => {
  it("moves from opt-in to first question", () => {
    expect(nextStateAfterOptIn("awaiting_opt_in")).toBe("intro_sent");
    expect(stateAfterIntroSent()).toBe("awaiting_voice_q1");
    expect(promptForState("awaiting_voice_q1")).toContain("voice note");
  });

  it("advances through voice questions then processing", () => {
    expect(questionIndexForState("awaiting_voice_q2")).toBe(1);
    expect(stateAfterVoiceAnswer("awaiting_voice_q1", 0)).toBe("awaiting_voice_q2");
    expect(stateAfterVoiceAnswer("awaiting_voice_q3", 2)).toBe("processing");
  });
});
