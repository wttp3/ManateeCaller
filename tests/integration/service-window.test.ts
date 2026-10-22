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

import { PROMPTS } from "../../src/interview/constants.js";
import { loadConfig } from "../../src/config/index.js";
import { InterviewService } from "../../src/services/interview.service.js";
import { encryptString } from "../../src/utils/crypto.js";
import { testEnv } from "../helpers/env.js";
import { memoryDebug, memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const PHONE = "+447700900000";
const KEY = "ab".repeat(32);

type RecordedCall = { url: string; method: string; body?: unknown };

let calls: RecordedCall[] = [];

beforeEach(() => {
  resetMemory();
  calls = [];
  installMediaFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMemory();
});

function installMediaFetch(failMessages = false): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    }
    calls.push({ url, method, body });
    if (url.includes("elevenlabs.io")) {
      return new Response(JSON.stringify({ text: "still blue water" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/messages")) {
      return new Response(failMessages ? "nope" : "{}", {
        status: failMessages ? 500 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "DELETE") {
      return new Response("", { status: 200 });
    }
    if (url.includes("lookaside.facebook.com")) {
      return new Response(Uint8Array.from([1, 2, 3, 4]));
    }
    if (url.includes("graph.facebook.com")) {
      return new Response(
        JSON.stringify({ url: "https://lookaside.facebook.com/media-1", mime_type: "audio/ogg" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
}

function messageBodies(): string[] {
  return calls
    .filter((call) => call.url.includes("/messages"))
    .map((call) => (call.body as { text?: { body?: string } }).text?.body ?? "");
}

function seedSession(state: string, expiresAt: Date | null): { participantId: string; sessionId: string } {
  const participantId = randomUUID();
  const sessionId = randomUUID();
  const now = new Date();
  memorySnapshot().participants.push({
    id: participantId,
    encrypted_phone: encryptString(PHONE, KEY),
    phone_lookup_hash: "a".repeat(64),
    encrypted_name: encryptString("Ada", KEY),
    status: "active",
    created_at: now,
    updated_at: now,
  });
  memorySnapshot().sessions.push({
    id: sessionId,
    participant_id: participantId,
    state,
    current_question_index: 0,
    service_window_expires_at: expiresAt,
    created_at: now,
    updated_at: now,
    completed_at: null,
  });
  return { participantId, sessionId };
}

function interview(): InterviewService {
  return new InterviewService(loadConfig(testEnv({ PILOT_ALLOWED_SENDERS: PHONE })));
}

describe("24-hour service window", () => {
  it("does not call Graph when the window is closed and drops the expired prompt", async () => {
    const { participantId, sessionId } = seedSession("awaiting_voice_q1", new Date(Date.now() - 60_000));
    await interview().processVoiceNote({ sessionId, participantId, mediaId: "media-closed" });
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    expect(memorySnapshot().sessions[0]?.state).toBe("expired");
    expect(calls.filter((call) => call.url.includes("graph.facebook.com"))).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes("elevenlabs.io"))).toHaveLength(0);
    expect(messageBodies().join("\n")).not.toContain(PROMPTS.expired);
  });

  it("treats a missing window as closed", async () => {
    const { participantId, sessionId } = seedSession("awaiting_voice_q1", null);
    await interview().processVoiceNote({ sessionId, participantId, mediaId: "media-null" });
    expect(memorySnapshot().sessions[0]?.state).toBe("expired");
    expect(messageBodies()).toEqual([]);
  });

  it("sends the next question and only then advances state", async () => {
    const { participantId, sessionId } = seedSession("awaiting_voice_q1", new Date(Date.now() + 60 * 60 * 1000));
    await interview().processVoiceNote({ sessionId, participantId, mediaId: "media-open" });
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    const session = memorySnapshot().sessions[0];
    expect(session?.state).toBe("awaiting_voice_q2");
    expect(session?.current_question_index).toBe(1);
    expect(messageBodies()).toHaveLength(1);
    expect(messageBodies()[0]).toContain("gentle moment");
    expect(messageBodies()[0]).not.toContain(PROMPTS.expired);
  });

  it("leaves the question in place when the next free-form send fails", async () => {
    installMediaFetch(true);
    const { participantId, sessionId } = seedSession("awaiting_voice_q1", new Date(Date.now() + 60 * 60 * 1000));
    await expect(
      interview().processVoiceNote({ sessionId, participantId, mediaId: "media-fail" }),
    ).rejects.toThrow(/WhatsApp send failed/);
    const session = memorySnapshot().sessions[0];
    expect(session?.state).toBe("awaiting_voice_q1");
    expect(session?.current_question_index).toBe(0);
  });

  it("enqueues finalize with the participant id and no phone number", async () => {
    const { participantId, sessionId } = seedSession("awaiting_voice_q3", new Date(Date.now() + 60 * 60 * 1000));
    await interview().processVoiceNote({ sessionId, participantId, mediaId: "media-last-open" });
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    expect(memorySnapshot().sessions[0]?.state).toBe("processing");
    expect(memorySnapshot().jobs).toHaveLength(1);
    const payload = JSON.parse(memorySnapshot().jobs[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({ sessionId, participantId });
    expect(memorySnapshot().jobs[0]?.participant_id).toBe(participantId);
    expect(JSON.stringify(payload)).not.toContain(PHONE);
    expect(JSON.stringify(payload)).not.toContain(PHONE.slice(1));
  });

  it("expires the last answer without enqueueing finalize when the window is closed", async () => {
    const { participantId, sessionId } = seedSession("awaiting_voice_q3", new Date(Date.now() - 1000));
    await interview().processVoiceNote({ sessionId, participantId, mediaId: "media-last" });
    expect(memorySnapshot().sessions[0]?.state).toBe("expired");
    expect(memorySnapshot().jobs).toHaveLength(0);
    expect(messageBodies()).toEqual([]);
  });

  it("does not send the mosaic link after the window has closed", async () => {
    const { participantId, sessionId } = seedSession("processing", new Date(Date.now() - 1000));
    await interview().finalizeInterview({ sessionId, participantId });
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    expect(memorySnapshot().sessions[0]?.state).toBe("expired");
    expect(memorySnapshot().artwork).toHaveLength(0);
    expect(messageBodies()).toEqual([]);
    expect(calls.filter((call) => call.url.includes("graph.facebook.com"))).toHaveLength(0);
  });

  it("sends the mosaic link and marks the session complete only after that send", async () => {
    const { participantId, sessionId } = seedSession("processing", new Date(Date.now() + 60 * 60 * 1000));
    memorySnapshot().responses.push({
      session_id: sessionId,
      question_index: 0,
      encrypted_transcript: encryptString("calm water", KEY),
    });
    await interview().finalizeInterview({ sessionId, participantId });
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    expect(memorySnapshot().sessions[0]?.state).toBe("complete");
    expect(memorySnapshot().artwork).toHaveLength(1);
    expect(messageBodies()).toHaveLength(1);
    expect(messageBodies()[0]).toContain("/mosaic.html#");
    expect(messageBodies()[0]).not.toContain(PROMPTS.expired);
  });

  it("does not complete the session when the mosaic send fails", async () => {
    installMediaFetch(true);
    const { participantId, sessionId } = seedSession("processing", new Date(Date.now() + 60 * 60 * 1000));
    memorySnapshot().responses.push({
      session_id: sessionId,
      question_index: 0,
      encrypted_transcript: encryptString("calm water", KEY),
    });
    await expect(interview().finalizeInterview({ sessionId, participantId })).rejects.toThrow(/WhatsApp send failed/);
    expect(memorySnapshot().sessions[0]?.state).toBe("processing");
    expect(memorySnapshot().artwork).toHaveLength(0);
  });
});
