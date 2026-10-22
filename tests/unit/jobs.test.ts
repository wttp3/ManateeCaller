import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { assertPayloadHasNoPhone, JobService, sanitiseStoredError } from "../../src/services/job.service.js";
import { testEnv } from "../helpers/env.js";

describe("job payloads", () => {
  it("rejects a plaintext phone number before touching the database", async () => {
    const jobs = new JobService(loadConfig(testEnv()));
    await expect(
      jobs.enqueue("finalize_interview", { sessionId: "session-1", phone: "+447700900000" }),
    ).rejects.toThrow(/phone number/);
    await expect(
      jobs.enqueue("finalize_interview", { sessionId: "session-1", participantId: "id-1", note: "call +447700900000" }),
    ).rejects.toThrow(/phone number/);
  });

  it("rejects nested phone keys, message ids, and digit runs", () => {
    expect(() => assertPayloadHasNoPhone({ meta: { phone: "447700900000" } })).toThrow(/phone number/);
    expect(() => assertPayloadHasNoPhone({ nested: { note: "call 447700900000 today" } })).toThrow(/phone number/);
    expect(() => assertPayloadHasNoPhone({ messageId: "wamid.HBgL" })).toThrow(/phone number/);
    expect(() =>
      assertPayloadHasNoPhone({
        mediaId: "123456789012345",
        participantId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).not.toThrow();
  });

  it("strips numbers from stored errors and caps the length", () => {
    const stored = sanitiseStoredError(`provider body 447700900000 ${"x".repeat(400)}`);
    expect(stored).not.toContain("447700900000");
    expect(stored.length).toBeLessThanOrEqual(160);
  });
});
