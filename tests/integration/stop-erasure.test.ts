import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { PROMPTS } from "../../src/interview/constants.js";
import { OptOutSendRefusedError } from "../../src/pilot/allowlist.js";
import { InterviewService } from "../../src/services/interview.service.js";
import { WhatsAppService } from "../../src/services/whatsapp.service.js";
import { encryptString } from "../../src/utils/crypto.js";
import { testEnv } from "../helpers/env.js";
import { installFetchMock, type RecordedCall } from "../helpers/fetch-mock.js";
import { memoryDebug, memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const ALLOWED = "+447700900000";
const APP_SECRET = "secret-value";
const KEY = "ab".repeat(32);

let calls: RecordedCall[] = [];
const servers: Server[] = [];
let messageSeq = 0;

beforeEach(() => {
  resetMemory();
  calls = installFetchMock();
  messageSeq = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMemory();
});

async function startApp(overrides: Record<string, string> = {}): Promise<{ base: string; config: ReturnType<typeof loadConfig> }> {
  const config = loadConfig(testEnv({ PILOT_ALLOWED_SENDERS: ALLOWED, ...overrides }));
  const app = createApp(config);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, config };
}

function sign(body: Buffer): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function textBody(text: string): Buffer {
  messageSeq += 1;
  return Buffer.from(
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: `wamid.stop.${messageSeq}`,
                    from: ALLOWED.replace(/^\+/, ""),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}

function audioBody(): Buffer {
  messageSeq += 1;
  return Buffer.from(
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: `wamid.audio.${messageSeq}`,
                    from: ALLOWED.replace(/^\+/, ""),
                    type: "audio",
                    audio: { id: `media-${messageSeq}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}

async function postWebhook(base: string, body: Buffer): Promise<Response> {
  return fetch(`${base}/webhook/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    },
    body,
  });
}

function graphMessages(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("/messages"));
}

function messageBodies(): string[] {
  return graphMessages().map((call) => (call.body as { text?: { body?: string } }).text?.body ?? "");
}

function elevenCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("elevenlabs.io"));
}

function unexpectedSql(): string[] {
  return memoryDebug.errors.filter((error) => error.startsWith("Unhandled"));
}

async function optIn(base: string): Promise<void> {
  const response = await postWebhook(base, textBody("I'm in"));
  expect(response.status).toBe(200);
  await vi.waitFor(() => {
    expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
  });
  expect(unexpectedSql()).toEqual([]);
}

describe("stop and erasure", () => {
  it("opts in, accepts a voice note, then STOP blocks every later send", async () => {
    const { base, config } = await startApp();
    await optIn(base);
    expect(graphMessages()).toHaveLength(2);
    expect(elevenCalls()).toHaveLength(0);

    const voice = await postWebhook(base, audioBody());
    expect(voice.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().jobs).toHaveLength(1);
    });
    const queued = memorySnapshot().jobs[0];
    const payload = JSON.parse(queued?.payload_json ?? "{}") as {
      sessionId: string;
      participantId: string;
      mediaId: string;
    };
    expect(payload.participantId).toBe(memorySnapshot().participants[0]?.id);
    expect(queued?.participant_id).toBe(payload.participantId);
    expect(JSON.stringify(payload)).not.toContain(ALLOWED);
    expect(JSON.stringify(payload)).not.toContain(ALLOWED.slice(1));
    expect(graphMessages()).toHaveLength(2);

    const stopped = await postWebhook(base, textBody("  StOp  "));
    expect(stopped.status).toBe(200);
    await vi.waitFor(() => {
      expect(messageBodies()).toEqual([
        expect.stringContaining("Welcome to ManateeCaller"),
        expect.stringContaining("voice note"),
        PROMPTS.optOut,
      ]);
    });
    expect(unexpectedSql()).toEqual([]);
    expect(memorySnapshot().participants[0]?.status).toBe("opted_out");
    expect(memorySnapshot().sessions[0]?.state).toBe("opted_out");
    expect(memorySnapshot().consents.every((consent) => consent.withdrawn_at !== null)).toBe(true);
    expect(memorySnapshot().suppression.map((row) => row.reason)).toEqual(["stop"]);
    expect(memorySnapshot().jobs[0]?.status).toBe("cancelled");
    expect(memorySnapshot().jobs[0]?.payload_json).toBe("{}");
    expect(elevenCalls()).toHaveLength(0);

    await new InterviewService(config).processVoiceNote(payload);
    expect(unexpectedSql()).toEqual([]);
    expect(graphMessages()).toHaveLength(3);
    expect(elevenCalls()).toHaveLength(0);

    memorySnapshot().jobs[0]!.status = "pending";
    await new InterviewService(config).processVoiceNote(payload);
    expect(graphMessages()).toHaveLength(3);
    expect(elevenCalls()).toHaveLength(0);

    const later = await postWebhook(base, textBody("hello"));
    expect(later.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().webhookEvents.length).toBeGreaterThan(2);
    });
    expect(graphMessages()).toHaveLength(3);

    const whatsapp = new WhatsAppService(config);
    await expect(whatsapp.sendText(ALLOWED, "follow up")).rejects.toBeInstanceOf(OptOutSendRefusedError);
    expect(graphMessages()).toHaveLength(3);

    const again = await postWebhook(base, textBody("STOP"));
    expect(again.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().compliance.filter((row) => row.action === "stop_received").length).toBeGreaterThan(1);
    });
    expect(graphMessages()).toHaveLength(3);

    const returned = await postWebhook(base, textBody("I'm in"));
    expect(returned.status).toBe(200);
    await vi.waitFor(() => {
      expect(graphMessages()).toHaveLength(5);
    });
    expect(unexpectedSql()).toEqual([]);
    expect(memorySnapshot().participants[0]?.status).toBe("active");
    expect(memorySnapshot().suppression).toHaveLength(0);
    expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    expect(messageBodies().slice(3).every((body) => body.length > 0)).toBe(true);
    expect(elevenCalls()).toHaveLength(0);
  });

  it("honours STOP with no session, after completion, and when the window is closed", async () => {
    const { base } = await startApp();

    const neverStarted = await postWebhook(base, textBody("  CaNcEl "));
    expect(neverStarted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().suppression).toHaveLength(1);
    });
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(graphMessages()).toHaveLength(0);
    expect(memorySnapshot().suppression[0]?.reason).toBe("stop");

    const cameBack = await postWebhook(base, textBody("I'm in"));
    expect(cameBack.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    });
    expect(graphMessages()).toHaveLength(2);

    const openSession = memorySnapshot().sessions[0];
    if (!openSession) {
      throw new Error("missing session");
    }
    openSession.state = "complete";
    openSession.service_window_expires_at = new Date(Date.now() + 60 * 60 * 1000);
    const completed = await postWebhook(base, textBody("opt-out"));
    expect(completed.status).toBe(200);
    await vi.waitFor(() => {
      expect(messageBodies().at(-1)).toBe(PROMPTS.optOut);
    });
    expect(memorySnapshot().participants[0]?.status).toBe("opted_out");
    expect(memorySnapshot().sessions[0]?.state).toBe("complete");
    const afterComplete = graphMessages().length;

    const closed = memorySnapshot().sessions[0];
    if (!closed) {
      throw new Error("missing session after stop");
    }
    memorySnapshot().participants[0]!.status = "active";
    memorySnapshot().suppression.splice(0, memorySnapshot().suppression.length);
    closed.state = "expired";
    closed.service_window_expires_at = new Date(Date.now() - 60_000);
    const expired = await postWebhook(base, textBody("unsubscribe"));
    expect(expired.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants[0]?.status).toBe("opted_out");
    });
    expect(graphMessages()).toHaveLength(afterComplete);
    expect(elevenCalls()).toHaveLength(0);
    expect(unexpectedSql()).toEqual([]);
  });

  it("cancels a pending invite and rechecks before the outbox sends", async () => {
    const { base, config } = await startApp({ WHATSAPP_TEMPLATE_INVITES_ENABLED: "true" });
    const signup = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        phone: ALLOWED,
        whatsappConsent: true,
        voiceConsent: true,
        privacyAccepted: true,
        ageConfirmed: true,
      }),
    });
    expect(signup.status).toBe(201);
    expect(memorySnapshot().outbox[0]?.status).toBe("pending");
    expect(memorySnapshot().sessions[0]?.service_window_expires_at).toBeNull();

    const stopped = await postWebhook(base, textBody("OPT OUT"));
    expect(stopped.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants[0]?.status).toBe("opted_out");
    });
    expect(unexpectedSql()).toEqual([]);
    expect(memorySnapshot().outbox[0]?.status).toBe("cancelled");
    expect(graphMessages()).toHaveLength(0);

    memorySnapshot().outbox[0]!.status = "pending";
    await new InterviewService(config).processOutbox();
    expect(unexpectedSql()).toEqual([]);
    expect(memorySnapshot().outbox[0]?.status).toBe("cancelled");
    expect(graphMessages()).toHaveLength(0);
    expect(elevenCalls()).toHaveLength(0);
  });

  it("opts in, erases from the sender's number, and confirms once", async () => {
    const { base } = await startApp();
    await optIn(base);
    const participant = memorySnapshot().participants[0];
    const session = memorySnapshot().sessions[0];
    if (!participant || !session) {
      throw new Error("missing opt-in rows");
    }

    memorySnapshot().responses.push({
      session_id: session.id,
      question_index: 0,
      encrypted_transcript: encryptString("secret words", KEY),
      whatsapp_media_id: "media-private",
    });
    memorySnapshot().artwork.push({
      session_id: session.id,
      color_hex: "#123456",
      public_slug: "tilepublic01",
    });
    memorySnapshot().jobs.push({
      id: "job-voice",
      job_type: "process_voice_note",
      payload_json: JSON.stringify({ sessionId: session.id, participantId: participant.id, mediaId: "media-private" }),
      participant_id: participant.id,
      status: "pending",
    });

    const erased = await postWebhook(base, textBody("  Delete   MY   data "));
    expect(erased.status).toBe(200);
    await vi.waitFor(() => {
      expect(messageBodies().at(-1)).toBe(PROMPTS.erased);
    });
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(unexpectedSql()).toEqual([]);

    const store = memorySnapshot();
    expect(store.consents).toHaveLength(0);
    expect(store.sessions).toHaveLength(0);
    expect(store.responses).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    expect(store.webhookEvents).toHaveLength(0);
    expect(store.artwork).toHaveLength(1);
    expect(store.artwork[0]?.session_id).toBeNull();
    expect(store.artwork[0]?.color_hex).toBe("#123456");
    expect(store.suppression.map((row) => row.reason)).toEqual(["erasure_request"]);
    expect(store.compliance.map((row) => row.action)).toContain("participant_erased");
    const dumped = JSON.stringify(store);
    expect(dumped).not.toContain("secret words");
    expect(dumped).not.toContain("media-private");
    expect(dumped).not.toContain(ALLOWED.slice(1));

    expect(graphMessages()).toHaveLength(3);
    expect(messageBodies()[2]).toBe(PROMPTS.erased);
    expect(elevenCalls()).toHaveLength(0);

    const repeat = await postWebhook(base, textBody("DELETE MY DATA"));
    expect(repeat.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().webhookEvents).toHaveLength(0);
    });
    expect(graphMessages()).toHaveLength(3);
    expect(memorySnapshot().participants).toHaveLength(0);

    const returned = await postWebhook(base, textBody("I'm in"));
    expect(returned.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().webhookEvents).toHaveLength(1);
    });
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(graphMessages()).toHaveLength(3);
    expect(elevenCalls()).toHaveLength(0);
  });

  it("does not erase from the public participant-id route unless an admin token matches", async () => {
    const open = await startApp();
    await optIn(open.base);
    const participantId = memorySnapshot().participants[0]?.id;
    expect(participantId).toBeTruthy();

    const missing = await fetch(`${open.base}/api/erasure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId }),
    });
    expect(missing.status).toBe(404);
    expect(memorySnapshot().participants).toHaveLength(1);

    const locked = await startApp({ ERASURE_ADMIN_TOKEN: "test-admin-token" });
    const wrong = await fetch(`${locked.base}/api/erasure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ participantId }),
    });
    expect(wrong.status).toBe(401);
    expect(memorySnapshot().participants).toHaveLength(1);
    expect(graphMessages()).toHaveLength(2);

    const accepted = await fetch(`${locked.base}/api/erasure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-admin-token",
      },
      body: JSON.stringify({ participantId }),
    });
    expect(accepted.status).toBe(200);
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(memorySnapshot().sessions).toHaveLength(0);
    expect(memorySnapshot().consents).toHaveLength(0);
    expect(memorySnapshot().suppression.map((row) => row.reason)).toEqual(["erasure_request"]);
    expect(graphMessages()).toHaveLength(2);
    expect(unexpectedSql()).toEqual([]);
  });
});
