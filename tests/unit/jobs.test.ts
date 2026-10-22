import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { JobService } from "../../src/services/job.service.js";
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
});
