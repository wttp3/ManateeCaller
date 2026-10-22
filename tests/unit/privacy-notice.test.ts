import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONSENT_TEXT_VERSION } from "../../src/interview/constants.js";

const privacy = readFileSync(new URL("../../public/privacy.html", import.meta.url), "utf8");
const signup = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

describe("pilot privacy notice", () => {
  it("names the controller and drops placeholders", () => {
    expect(privacy).toContain("Straight Six Limited");
    expect(privacy).toContain("Unit C21 Parkhall Business Centre");
    expect(privacy).toContain("40 Martell Road");
    expect(privacy).toContain("London");
    expect(privacy).toContain("SE21 8EN");
    expect(privacy.toLowerCase()).not.toContain("placeholder");
  });

  it("states the default keywords, retention, and ElevenLabs default", () => {
    expect(privacy).toContain("I'm in");
    expect(privacy).toContain("STOP");
    expect(privacy).toContain("DELETE MY DATA");
    expect(privacy).toContain("hello@manateecaller.net");
    expect(privacy).toContain("https://elevenlabs.io/privacy");
    expect(privacy).toContain("https://ico.org.uk/make-a-complaint/");
    expect(privacy).toContain("Zero retention is off by default");
    expect(privacy).toContain("still to be confirmed");
    expect(privacy).not.toContain("UK or the EU");
    expect(privacy).not.toContain("server in the UK or the EU");
  });

  it("covers transfers, retained hashes, rights, and the voluntary pilot", () => {
    expect(privacy).toContain("graph.facebook.com");
    expect(privacy).toContain("api.elevenlabs.io");
    expect(privacy).toContain("https://www.whatsapp.com/legal/business-solution-terms/");
    expect(privacy).toContain("https://www.facebook.com/legal/terms/Meta-Global-Processor-Terms/Europe");
    expect(privacy).toContain("https://elevenlabs.io/dpa");
    expect(privacy).toContain("https://elevenlabs.io/terms-of-use-eu");
    expect(privacy).toContain("data bridge");
    expect(privacy).toContain("IDTA");
    expect(privacy).toContain("Standard Contractual Clauses");
    expect(privacy).toContain("legitimate interests");
    expect(privacy).toContain("object");
    expect(privacy).toContain("access");
    expect(privacy).toContain("rectification");
    expect(privacy).toContain("restriction");
    expect(privacy).toContain("portability");
    expect(privacy).toContain("Withdrawing consent does not affect earlier processing");
    expect(privacy).toContain("Taking part is voluntary");
    expect(privacy).toContain("no work consequence");
    expect(privacy).toContain("does not reach any copy ElevenLabs keeps while logging is on");
    expect(privacy).toContain("compliance notes");
    expect(privacy).toContain("a record of each STOP and each erasure");
    expect(privacy).toContain("By default, template invites are off, so you start the chat");
  });

  it("shows the consent text version stored with keyword consent", () => {
    expect(CONSENT_TEXT_VERSION).toBe("2026-10-22-v1");
    expect(CONSENT_TEXT_VERSION.length).toBeLessThanOrEqual(32);
    expect(privacy).toContain(CONSENT_TEXT_VERSION);
    expect(privacy).toContain("22 October 2026");
  });

  it("is linked from the signup page", () => {
    const links = signup.match(/href="\/privacy\.html"/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(3);
  });
});
