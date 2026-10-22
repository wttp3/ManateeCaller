import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { OUTBOUND_REFUSED_MESSAGE, PilotSendRefusedError } from "../../src/pilot/allowlist.js";
import { WhatsAppService } from "../../src/services/whatsapp.service.js";
import { ElevenLabsService } from "../../src/services/elevenlabs.service.js";
import { testEnv } from "../helpers/env.js";
import { installFetchMock, type RecordedCall } from "../helpers/fetch-mock.js";

const ALLOWED = "+447700900000";
const BLOCKED = "+14155552671";

let calls: RecordedCall[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function service(allowlist: string): WhatsAppService {
  calls = installFetchMock();
  return new WhatsAppService(
    loadConfig(
      testEnv({
        PILOT_ALLOWED_SENDERS: allowlist,
      }),
    ),
  );
}

describe("WhatsApp outbound allowlist", () => {
  it("sends free-form text only to an allowlisted number and does not call ElevenLabs", async () => {
    const whatsapp = service(ALLOWED);
    await whatsapp.sendText(ALLOWED, "Hello from the pilot");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("graph.facebook.com");
    expect(calls[0]?.url).toContain("/messages");
    expect(calls[0]?.body).toMatchObject({
      type: "text",
      to: "447700900000",
      text: { body: "Hello from the pilot" },
    });
    expect(calls.some((call) => call.url.includes("elevenlabs.io"))).toBe(false);
  });

  it("refuses outbound text and template sends for numbers that are not allowlisted", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const whatsapp = service(ALLOWED);

    await expect(whatsapp.sendText(BLOCKED, "nope")).rejects.toBeInstanceOf(PilotSendRefusedError);
    await expect(whatsapp.sendTemplate(BLOCKED, "manatee_invite")).rejects.toBeInstanceOf(PilotSendRefusedError);

    expect(calls).toHaveLength(0);
    const combined = logs.join("\n");
    expect(combined).toContain(OUTBOUND_REFUSED_MESSAGE);
    expect(combined).toContain("+14•••••2671");
    expect(combined).not.toContain("14155552671");
    expect(combined).not.toContain(BLOCKED);
  });

  it("refuses every outbound send when the allowlist is empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const whatsapp = service("");
    const error = await whatsapp.sendText(ALLOWED, "nope").then(
      () => {
        throw new Error("send should have been refused");
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(PilotSendRefusedError);
    expect(error instanceof Error ? error.message : "").not.toContain("447700900000");
    expect(calls).toHaveLength(0);
  });

  it("sends a template only through the mocked WhatsApp client when the recipient is allowlisted", async () => {
    const whatsapp = service(`${ALLOWED},${BLOCKED}`);
    await whatsapp.sendTemplate(ALLOWED, "manatee_invite");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      type: "template",
      to: "447700900000",
      template: { name: "manatee_invite" },
    });
  });

  it("mocks ElevenLabs transcription instead of calling the network", async () => {
    calls = installFetchMock();
    const config = loadConfig(testEnv());
    const eleven = new ElevenLabsService(config);
    await expect(eleven.transcribeAudio(Buffer.from("voice"), "note.ogg")).resolves.toBe("mocked transcript");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("https://api.elevenlabs.io/v1/speech-to-text");
    expect(calls[0]?.url).not.toContain("graph.facebook.com");
  });
});
