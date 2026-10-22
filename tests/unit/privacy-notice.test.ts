import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(privacy).toContain("UK or the EU");
  });

  it("is linked from the signup page", () => {
    expect(signup).toContain('href="/privacy.html"');
  });
});
