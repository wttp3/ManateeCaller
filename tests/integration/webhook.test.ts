import { createHmac } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
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
import { InterviewService } from "../../src/services/interview.service.js";
import { resetWebhookLocks } from "../../src/webhook/once.js";
import { testEnv } from "../helpers/env.js";
import { installFetchMock, passthroughFetch, type RecordedCall } from "../helpers/fetch-mock.js";
import { memoryDebug, memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const APP_SECRET = "secret-value";
const ALLOWED = "+447700900000";
const servers: Server[] = [];
let calls: RecordedCall[] = [];

beforeEach(() => {
  resetMemory();
  resetWebhookLocks();
  calls = installFetchMock();
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
  resetWebhookLocks();
  resetMemory();
});

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function startApp(overrides: Record<string, string> = {}): Promise<string> {
  const app = createApp(loadConfig(testEnv({ PILOT_ALLOWED_SENDERS: ALLOWED, ...overrides })));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function optInBody(id: string, text = "I'm in"): Buffer {
  return Buffer.from(
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id, from: "447700900000", type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    }),
  );
}

function postRaw(
  base: string,
  body: Buffer,
  headers: Record<string, string | undefined>,
): Promise<{ status: number }> {
  const url = new URL("/webhook/whatsapp", base);
  const finalHeaders: Record<string, string> = { "content-length": String(body.length) };
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      finalHeaders[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: finalHeaders,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function expectQuiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  const store = memorySnapshot();
  expect(store.participants).toHaveLength(0);
  expect(store.sessions).toHaveLength(0);
  expect(store.webhookEvents).toHaveLength(0);
  expect(store.jobs).toHaveLength(0);
  expect(store.outbox).toHaveLength(0);
  expect(calls.filter((call) => call.url.includes("graph.facebook.com"))).toHaveLength(0);
  expect(calls.filter((call) => call.url.includes("elevenlabs.io"))).toHaveLength(0);
}

describe("whatsapp webhook signature", () => {
  it("returns 403 for a bad signature and does not create a participant", async () => {
    const base = await startApp();
    const body = Buffer.from(
      JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ id: "wamid.bad", from: "447700900000", type: "text", text: { body: "I'm in" } }] } }] }],
      }),
    );
    const response = await fetch(`${base}/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body,
    });
    expect(response.status).toBe(403);
    expect(memorySnapshot().participants).toHaveLength(0);
    expect(memorySnapshot().webhookEvents).toHaveLength(0);
  });

  it("returns 200 for a good signature", async () => {
    const base = await startApp();
    const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
    const response = await fetch(`${base}/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    expect(response.status).toBe(200);

    const optedIn = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { id: "wamid.good.1", from: "447700900000", type: "text", text: { body: "I'm in" } },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const accepted = await fetch(`${base}/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(optedIn),
      },
      body: optedIn,
    });
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
  });
});

describe("forwarded webhook bytes", () => {
  it("verifies a body whose Content-Type charset is not utf-8", async () => {
    const base = await startApp();
    const raw = Buffer.from(
      '{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.charset.1","from":"447700900000","type":"text","text":{"body":"I’m in"}}]}}]}]} \n',
    );
    const reencoded = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
    expect(reencoded.equals(raw)).toBe(false);

    const accepted = await postRaw(base, raw, {
      "content-type": "application/json; charset=iso-8859-1",
      "x-hub-signature-256": sign(raw),
    });
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });

    const rejected = await postRaw(base, reencoded, {
      "content-type": "application/json; charset=iso-8859-1",
      "x-hub-signature-256": sign(raw),
    });
    expect(rejected.status).toBe(403);
    expect(memorySnapshot().participants).toHaveLength(1);
    expect(memorySnapshot().webhookEvents).toHaveLength(1);
  });

  it("ignores an extra proxy header when the signature matches the body", async () => {
    const base = await startApp();
    const body = optInBody("wamid.proxy.1");
    const response = await postRaw(base, body, {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      via: "1.1 whatsapp-mcp",
      "x-proxy-extra": "forwarded",
      "x-hub-signature-256": sign(body),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
    expect(memorySnapshot().webhookEvents).toHaveLength(1);
  });

  it("verifies a gzip-decoded body over the bytes that arrived", async () => {
    const base = await startApp();
    const decoded = optInBody("wamid.gzip.decoded");
    const compressed = gzipSync(decoded);
    expect(compressed[0]).toBe(0x1f);

    const staleEncoding = await postRaw(base, decoded, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-hub-signature-256": sign(decoded),
    });
    expect(staleEncoding.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });

    const signedAsGzip = await postRaw(base, decoded, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-hub-signature-256": sign(compressed),
    });
    expect(signedAsGzip.status).toBe(403);
    expect(memorySnapshot().participants).toHaveLength(1);
  });

  it("verifies a still-gzipped body before inflating it", async () => {
    const base = await startApp();
    const decoded = optInBody("wamid.gzip.raw");
    const compressed = gzipSync(decoded);

    const mismatch = await postRaw(base, compressed, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-hub-signature-256": sign(decoded),
    });
    expect(mismatch.status).toBe(403);
    expect(memorySnapshot().participants).toHaveLength(0);

    const accepted = await postRaw(base, compressed, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-hub-signature-256": sign(compressed),
    });
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
    expect(memorySnapshot().webhookEvents).toHaveLength(1);
  });

  it("returns 403 when the signature is missing or empty", async () => {
    const base = await startApp();
    const body = optInBody("wamid.unsigned");

    const missing = await postRaw(base, body, { "content-type": "application/json" });
    expect(missing.status).toBe(403);

    const empty = await postRaw(base, body, {
      "content-type": "application/json",
      "x-hub-signature-256": "",
    });
    expect(empty.status).toBe(403);

    const emptyDigest = await postRaw(base, body, {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=",
    });
    expect(emptyDigest.status).toBe(403);
    await expectQuiet();
  });
});

describe("webhook idempotency", () => {
  it("processes one voice note once across retries and concurrent forwards", async () => {
    calls = installMediaFetch();
    const overrides = { PILOT_ALLOWED_SENDERS: ALLOWED, TEMP_AUDIO_DIR: "./tmp/webhook-idempotency" };
    const base = await startApp(overrides);
    const config = loadConfig(testEnv(overrides));

    const optedIn = await postRaw(base, optInBody("wamid.optin.once"), {
      "content-type": "application/json",
      "x-hub-signature-256": sign(optInBody("wamid.optin.once")),
    });
    expect(optedIn.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().sessions.some((session) => session.state === "awaiting_voice_q1")).toBe(true);
    });
    expect(messageSends()).toHaveLength(2);

    const voice = voiceBody("wamid.voice.once", "media-voice-once");
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "x-forwarded-for": "203.0.113.50",
      via: "1.1 whatsapp-mcp",
      "x-hub-signature-256": sign(voice),
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => postRaw(base, voice, headers)),
    );
    const repeated = await postRaw(base, voice, headers);
    expect(concurrent.every((response) => response.status === 200)).toBe(true);
    expect(repeated.status).toBe(200);

    await vi.waitFor(() => {
      expect(memorySnapshot().jobs).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const voiceEvents = memorySnapshot().webhookEvents.filter((event) => event.event_key === "msg:wamid.voice.once");
    expect(voiceEvents).toHaveLength(1);
    expect(memorySnapshot().jobs).toHaveLength(1);
    expect(memorySnapshot().jobs[0]?.job_type).toBe("process_voice_note");
    expect(messageSends()).toHaveLength(2);

    const payload = JSON.parse(memorySnapshot().jobs[0]?.payload_json ?? "{}") as {
      sessionId: string;
      participantId: string;
      mediaId: string;
    };
    await new InterviewService(config).processVoiceNote(payload);
    expect(memoryDebug.errors.filter((error) => error.startsWith("Unhandled"))).toEqual([]);
    expect(messageSends()).toHaveLength(3);
    expect(messageSends().at(-1)?.body).toMatchObject({
      type: "text",
      text: { body: expect.stringContaining("gentle moment") },
    });
    expect(calls.filter((call) => call.url.includes("elevenlabs.io"))).toHaveLength(1);

    const again = await postRaw(base, voice, headers);
    expect(again.status).toBe(200);
    const status = await postRaw(base, statusBody("delivered", "wamid.voice.once"), {
      "content-type": "application/json",
      "x-hub-signature-256": sign(statusBody("delivered", "wamid.voice.once")),
    });
    expect(status.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(memorySnapshot().webhookEvents.filter((event) => event.event_key === "msg:wamid.voice.once")).toHaveLength(1);
    expect(memorySnapshot().jobs).toHaveLength(1);
    expect(messageSends()).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("elevenlabs.io"))).toHaveLength(1);
  });
});

describe("webhook events with no message", () => {
  it("accepts delivered and read callbacks without side effects", async () => {
    const base = await startApp();
    for (const status of ["delivered", "read"] as const) {
      const body = statusBody(status, `wamid.status.${status}`);
      const response = await postRaw(base, body, {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      });
      expect(response.status).toBe(200);
    }
    await expectQuiet();
  });

  it("accepts non-message events without side effects", async () => {
    const base = await startApp();
    const bodies = [
      Buffer.from(
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{ changes: [{ field: "account_update", value: { event: "PARTNER_ADDED" } }] }],
        }),
      ),
      Buffer.from(
        JSON.stringify({
          entry: [{ changes: [{ value: { errors: [{ code: 131026, title: "Message undeliverable" }] } }] }],
        }),
      ),
      Buffer.from(JSON.stringify({ object: "whatsapp_business_account" })),
    ];
    for (const body of bodies) {
      const response = await postRaw(base, body, {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      });
      expect(response.status).toBe(200);
    }
    await expectQuiet();
  });
});

describe("malformed webhook JSON", () => {
  it("returns 400 and does not write or call providers", async () => {
    const base = await startApp();
    const bodies = [
      Buffer.from("{not json"),
      Buffer.from(""),
      Buffer.from('{"entry":'),
      Buffer.from([0x1f, 0x8b, 0x00, 0x01]),
    ];
    for (const body of bodies) {
      const response = await postRaw(base, body, {
        "content-type": "application/json; charset=utf-8",
        "x-hub-signature-256": sign(body),
      });
      expect(response.status).toBe(400);
      expect(response.status).not.toBe(500);
    }
    await expectQuiet();
  });

  it("returns 200 for signed JSON that has no messages", async () => {
    const base = await startApp();
    for (const body of [Buffer.from("null"), Buffer.from("[]"), Buffer.from("42")]) {
      const response = await postRaw(base, body, {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      });
      expect(response.status).toBe(200);
      expect(response.status).not.toBe(500);
    }
    await expectQuiet();
  });
});

describe("webhook body cap", () => {
  it("rejects a body larger than the configured cap", async () => {
    const body = optInBody("wamid.too-big");
    const base = await startApp({ WHATSAPP_WEBHOOK_MAX_BYTES: String(body.length - 1) });
    const response = await postRaw(base, body, {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    });
    expect(response.status).toBe(413);
    expect(response.status).not.toBe(500);
    await expectQuiet();
  });

  it("accepts a body that is exactly the cap", async () => {
    const body = optInBody("wamid.exact-cap");
    const base = await startApp({ WHATSAPP_WEBHOOK_MAX_BYTES: String(body.length) });
    const response = await postRaw(base, body, {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
  });
});

describe("optional webhook forwarder", () => {
  const shared = "pilot-shared";

  it("stays off unless the env flag is set", async () => {
    const config = loadConfig(testEnv());
    expect(config.webhookForwarder).toEqual({ mode: "off" });
    expect(config.whatsappWebhookMaxBytes).toBe(256 * 1024);
    const base = await startApp();
    const body = optInBody("wamid.forwarder.off");
    const response = await postRaw(base, body, {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      "x-hub-signature-256": sign(body),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
  });

  it("rejects a peer that is not the expected forwarder IP", async () => {
    const base = await startApp({ WHATSAPP_WEBHOOK_FORWARDER: "203.0.113.10" });
    const body = optInBody("wamid.forwarder.ip");
    const spoofed = await postRaw(base, body, {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      "x-hub-signature-256": sign(body),
    });
    expect(spoofed.status).toBe(403);
    await expectQuiet();
  });

  it("accepts the TCP peer named by the flag", async () => {
    const base = await startApp({ WHATSAPP_WEBHOOK_FORWARDER: "127.0.0.1, ::ffff:127.0.0.1" });
    const body = optInBody("wamid.forwarder.local");
    const response = await postRaw(base, body, {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.8",
      "x-hub-signature-256": sign(body),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });
  });

  it("requires the shared header when that form is set, and does not log the value", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const base = await startApp({
      WHATSAPP_WEBHOOK_FORWARDER: `header:X-Webhook-Forwarder:${shared}`,
    });
    const body = optInBody("wamid.forwarder.header");
    const signed = {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    };

    const missing = await postRaw(base, body, signed);
    expect(missing.status).toBe(403);
    const wrong = await postRaw(base, body, { ...signed, "x-webhook-forwarder": "other-value" });
    expect(wrong.status).toBe(403);
    await expectQuiet();

    const accepted = await postRaw(base, body, { ...signed, "x-webhook-forwarder": shared });
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => {
      expect(memorySnapshot().participants).toHaveLength(1);
    });

    const health = await fetch(`${base}/health`);
    const healthText = await health.text();
    expect(healthText).toContain('"webhookForwarder":"header"');
    expect(healthText).not.toContain(shared);
    expect(logs.join("\n")).not.toContain(shared);
  });
});

function voiceBody(id: string, mediaId: string): Buffer {
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
                    from: "447700900000",
                    type: "audio",
                    audio: { id: mediaId, mime_type: "audio/ogg" },
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

function statusBody(status: "delivered" | "read", id: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                statuses: [
                  {
                    id,
                    status,
                    timestamp: "1710000000",
                    recipient_id: "447700900000",
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

function messageSends(): RecordedCall[] {
  return calls.filter((call) => call.url.includes("/messages"));
}

function installMediaFetch(): RecordedCall[] {
  const recorded: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return passthroughFetch(input, init);
      }
      let body: unknown = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // Keep the raw provider body.
        }
      }
      recorded.push({ url, body });
      if (url.includes("elevenlabs.io")) {
        return new Response(JSON.stringify({ text: "a calm morning" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("cdn.example")) {
        return new Response(Uint8Array.from([1, 2, 3, 4]));
      }
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response("", { status: 200 });
      }
      if (url.includes("/messages")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({ url: "https://cdn.example/media", mime_type: "audio/ogg" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected network call to ${url}`);
    }),
  );
  return recorded;
}
