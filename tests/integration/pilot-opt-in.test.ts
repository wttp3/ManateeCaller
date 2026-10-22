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
import { INBOUND_IGNORED_MESSAGE } from "../../src/pilot/allowlist.js";
import { InterviewService } from "../../src/services/interview.service.js";
import { testEnv } from "../helpers/env.js";
import { installFetchMock, type RecordedCall } from "../helpers/fetch-mock.js";
import { memoryDebug, memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const ALLOWED = "+447700900000";
const BLOCKED = "+14155552671";
const APP_SECRET = "secret-value";

let calls: RecordedCall[] = [];
let logs: string[] = [];
const servers: Server[] = [];

beforeEach(() => {
  resetMemory();
  calls = installFetchMock();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    logs.push(String(line));
  });
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
  const config = loadConfig(testEnv(overrides));
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

function webhookBody(from: string, text: string, id = "wamid.pilot.1"): Buffer {
  return Buffer.from(
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id,
                    from: from.replace(/^\+/, ""),
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

async function postWebhook(base: string, body: Buffer, signature = sign(body)): Promise<Response> {
  return fetch(`${base}/webhook/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function graphCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("graph.facebook.com"));
}

function elevenCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("elevenlabs.io"));
}

function unexpectedSql(): string[] {
  return memoryDebug.errors.filter((error) => error.startsWith("Unhandled"));
}

async function signup(base: string, phone: string): Promise<Response> {
  return fetch(`${base}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Ada",
      phone,
      whatsappConsent: true,
      voiceConsent: true,
      privacyAccepted: true,
      ageConfirmed: true,
    }),
  });
}

describe("pilot keyword opt-in", () => {
  it("rejects webhooks that are not signed with the test secret", async () => {
    const { base } = await startApp({ PILOT_ALLOWED_SENDERS: ALLOWED });
    const body = webhookBody(ALLOWED, "I'm in");
    const response = await postWebhook(base, body, "sha256=deadbeef");
    expect(response.status).toBe(403);
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(graphCalls()).toHaveLength(0);
    expect(elevenCalls()).toHaveLength(0);
  });

  it("ignores inbound messages from numbers outside the allowlist and logs a mask", async () => {
    const { base } = await startApp({ PILOT_ALLOWED_SENDERS: ALLOWED });
    const body = webhookBody(BLOCKED, "I'm in", "wamid.blocked.1");
    const response = await postWebhook(base, body);
    expect(response.status).toBe(200);
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(memorySnapshot().webhookEvents).toHaveLength(0);
    expect(graphCalls()).toHaveLength(0);
    const combined = logs.join("\n");
    expect(combined).toContain(INBOUND_IGNORED_MESSAGE);
    expect(combined).toContain("+14•••••2671");
    expect(combined).not.toContain("14155552671");
    expect(combined).not.toContain(BLOCKED);
  });

  it("ignores every inbound message when the allowlist is empty", async () => {
    const { base } = await startApp();
    const response = await postWebhook(base, webhookBody(ALLOWED, "I'm in", "wamid.empty.1"));
    expect(response.status).toBe(200);
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(graphCalls()).toHaveLength(0);
    expect(logs.join("\n")).toContain(INBOUND_IGNORED_MESSAGE);
  });

  it("starts consent and the session from the keyword with free-form messages only", async () => {
    const { base } = await startApp({ PILOT_ALLOWED_SENDERS: ALLOWED });
    const body = webhookBody(ALLOWED, "I’m in", "wamid.keyword.1");
    const response = await postWebhook(base, body);
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    });
    expect(unexpectedSql()).toEqual([]);

    const store = memorySnapshot();
    expect(store.participants).toHaveLength(1);
    expect(store.consents.map((consent) => consent.consent_type).sort()).toEqual([
      "privacy_notice",
      "voice_processing",
      "whatsapp_contact",
    ]);
    expect(store.outbox).toHaveLength(0);
    const session = store.sessions[0];
    expect(session?.state).toBe("awaiting_voice_q1");
    expect(session?.service_window_expires_at).not.toBeNull();
    const expires = session?.service_window_expires_at?.getTime() ?? 0;
    expect(expires).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(expires).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);

    expect(elevenCalls()).toHaveLength(0);
    expect(graphCalls()).toHaveLength(2);
    expect(graphCalls().every((call) => (call.body as { type?: string }).type === "text")).toBe(true);
    const bodies = graphCalls().map((call) => (call.body as { text: { body: string } }).text.body);
    expect(bodies[0]).toContain("Welcome to ManateeCaller");
    expect(bodies[1]).toContain("voice note");
    expect(graphCalls().some((call) => (call.body as { type?: string }).type === "template")).toBe(false);

    const duplicate = await postWebhook(base, body);
    expect(duplicate.status).toBe(200);
    await vi.waitFor(() => {
      expect(memoryDebug.errors).toContain("duplicate webhook event");
    });
    expect(graphCalls()).toHaveLength(2);
    expect(store.participants).toHaveLength(1);
  });

  it("uses a configured keyword and does not treat the default phrase as opt-in", async () => {
    const { base } = await startApp({
      PILOT_ALLOWED_SENDERS: ALLOWED,
      OPT_IN_KEYWORD: "count me in",
    });

    const ignored = await postWebhook(base, webhookBody(ALLOWED, "I'm in", "wamid.default.1"));
    expect(ignored.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().webhookEvents).toHaveLength(1);
    });
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(graphCalls()).toHaveLength(0);

    const accepted = await postWebhook(base, webhookBody(ALLOWED, "  Count   me in ", "wamid.custom.1"));
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    });
    expect(unexpectedSql()).toEqual([]);
    expect(graphCalls().every((call) => (call.body as { type?: string }).type === "text")).toBe(true);
  });

  it("does not send a template when someone signs up and then opts in by keyword", async () => {
    const { base } = await startApp({ PILOT_ALLOWED_SENDERS: ALLOWED });
    const response = await signup(base, ALLOWED);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { delivery: string; optInKeyword: string; participantId: string };
    expect(body.delivery).toBe("keyword");
    expect(body.optInKeyword).toBe("I'm in");
    expect(memorySnapshot().outbox).toHaveLength(0);
    expect(memorySnapshot().consents).toHaveLength(3);
    expect(graphCalls()).toHaveLength(0);

    const webhook = await postWebhook(base, webhookBody(ALLOWED, "I'm in", "wamid.after-signup.1"));
    expect(webhook.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    });
    expect(unexpectedSql()).toEqual([]);
    expect(memorySnapshot().participants).toHaveLength(1);
    expect(memorySnapshot().consents).toHaveLength(3);
    expect(memorySnapshot().outbox).toHaveLength(0);
    expect(graphCalls()).toHaveLength(2);
    expect(graphCalls().every((call) => (call.body as { type?: string }).type === "text")).toBe(true);
    expect(elevenCalls()).toHaveLength(0);
    const window = memorySnapshot().sessions[0]?.service_window_expires_at;
    expect(window).not.toBeNull();
  });

  it("keeps template delivery behind the flag and refuses sends that are not allowlisted", async () => {
    const enabled = await startApp({
      PILOT_ALLOWED_SENDERS: ALLOWED,
      WHATSAPP_TEMPLATE_INVITES_ENABLED: "true",
    });
    const created = await signup(enabled.base, ALLOWED);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { delivery: string };
    expect(createdBody.delivery).toBe("template");
    expect(memorySnapshot().outbox).toHaveLength(1);
    expect(memorySnapshot().outbox[0]?.message_type).toBe("template_invite");
    expect(graphCalls()).toHaveLength(0);

    const interview = new InterviewService(enabled.config);
    await interview.processOutbox();
    expect(unexpectedSql()).toEqual([]);
    expect(graphCalls()).toHaveLength(1);
    expect(graphCalls()[0]?.body).toMatchObject({
      type: "template",
      template: { name: "manatee_invite" },
      to: "447700900000",
    });
    expect(elevenCalls()).toHaveLength(0);
    expect(memorySnapshot().outbox[0]?.status).toBe("sent");
    expect(memorySnapshot().sessions[0]?.state).toBe("awaiting_opt_in");

    resetMemory();
    calls.splice(0, calls.length);
    const blockedSignup = await signup(enabled.base, BLOCKED);
    expect(blockedSignup.status).toBe(201);
    expect(memorySnapshot().outbox).toHaveLength(1);
    await expect(interview.processOutbox()).rejects.toThrow(/pilot allowlist/);
    expect(graphCalls()).toHaveLength(0);
    expect(elevenCalls()).toHaveLength(0);
    expect(memorySnapshot().outbox[0]?.status).toBe("pending");
    expect(memorySnapshot().outbox[0]?.attempts).toBe(1);
    expect(logs.join("\n")).not.toContain("14155552671");
  });

  it("does not send a queued template when the flag is off", async () => {
    const enabled = await startApp({
      PILOT_ALLOWED_SENDERS: ALLOWED,
      WHATSAPP_TEMPLATE_INVITES_ENABLED: "true",
    });
    expect((await signup(enabled.base, ALLOWED)).status).toBe(201);
    expect(memorySnapshot().outbox[0]?.status).toBe("pending");

    const disabled = loadConfig(
      testEnv({
        PILOT_ALLOWED_SENDERS: ALLOWED,
        WHATSAPP_TEMPLATE_INVITES_ENABLED: "false",
      }),
    );
    await new InterviewService(disabled).processOutbox();
    expect(unexpectedSql()).toEqual([]);
    expect(graphCalls()).toHaveLength(0);
    expect(elevenCalls()).toHaveLength(0);
    expect(memorySnapshot().outbox[0]?.status).toBe("skipped");
    expect(memorySnapshot().sessions[0]?.state).toBe("pending_invite");
  });
});
