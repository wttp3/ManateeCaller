import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/pool.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/pool.js")>("../../src/db/pool.js");
  const memory = await import("../helpers/memory-sql.js");
  return {
    ...actual,
    sql: {
      ...actual.sql,
      Transaction: memory.FakeTransaction,
      Request: memory.FakeRequest,
    },
    getPool: memory.getMemoryPool,
    closePool: async () => {},
  };
});

import { loadConfig } from "../../src/config/index.js";
import { OPT_OUT_REFUSED_MESSAGE, OUTBOUND_REFUSED_MESSAGE, OptOutSendRefusedError, PilotSendRefusedError } from "../../src/pilot/allowlist.js";
import { WhatsAppService } from "../../src/services/whatsapp.service.js";
import { ElevenLabsService } from "../../src/services/elevenlabs.service.js";
import { encryptString, hmacHex } from "../../src/utils/crypto.js";
import { testEnv } from "../helpers/env.js";
import { installFetchMock, type RecordedCall } from "../helpers/fetch-mock.js";
import { memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const ALLOWED = "+447700900000";
const BLOCKED = "+14155552671";

let calls: RecordedCall[] = [];

beforeEach(() => {
  resetMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMemory();
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

  it("refuses an opted-out or blocked number next to the allowlist guard", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const whatsapp = service(ALLOWED);
    const hash = hmacHex(ALLOWED, "ef".repeat(32));
    memorySnapshot().suppression.push({
      phone_lookup_hash: hash,
      reason: "stop",
      expires_at: null,
    });

    await expect(whatsapp.sendText(ALLOWED, "nope")).rejects.toBeInstanceOf(OptOutSendRefusedError);
    expect(calls).toHaveLength(0);
    const combined = logs.join("\n");
    expect(combined).toContain(OPT_OUT_REFUSED_MESSAGE);
    expect(combined).not.toContain(ALLOWED.slice(1));

    memorySnapshot().suppression.splice(0, memorySnapshot().suppression.length);
    const now = new Date();
    memorySnapshot().participants.push({
      id: randomUUID(),
      encrypted_phone: encryptString(ALLOWED, "ab".repeat(32)),
      phone_lookup_hash: hash,
      encrypted_name: encryptString("", "ab".repeat(32)),
      status: "blocked",
      created_at: now,
      updated_at: now,
    });
    await expect(whatsapp.sendText(ALLOWED, "nope")).rejects.toBeInstanceOf(OptOutSendRefusedError);
    expect(calls).toHaveLength(0);
  });

  it("lets one confirmation bypass the opt-out guard and still enforces the allowlist", async () => {
    const whatsapp = service(ALLOWED);
    memorySnapshot().suppression.push({
      phone_lookup_hash: hmacHex(ALLOWED, "ef".repeat(32)),
      reason: "stop",
      expires_at: null,
    });
    await whatsapp.sendText(ALLOWED, "You've been unsubscribed from ManateeCaller.", { bypassOptOut: true });
    expect(calls).toHaveLength(1);
    await expect(whatsapp.sendText(BLOCKED, "confirm", { bypassOptOut: true })).rejects.toBeInstanceOf(
      PilotSendRefusedError,
    );
    expect(calls).toHaveLength(1);
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
