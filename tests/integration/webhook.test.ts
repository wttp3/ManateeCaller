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
import { testEnv } from "../helpers/env.js";
import { installFetchMock } from "../helpers/fetch-mock.js";
import { memorySnapshot, resetMemory } from "../helpers/memory-sql.js";

const APP_SECRET = "secret-value";
const ALLOWED = "+447700900000";
const servers: Server[] = [];

beforeEach(() => {
  resetMemory();
  installFetchMock();
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

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function startApp(): Promise<string> {
  const app = createApp(loadConfig(testEnv({ PILOT_ALLOWED_SENDERS: ALLOWED })));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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
