import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { testEnv } from "../helpers/env.js";

const { getPool } = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../../src/db/pool.js", () => ({
  getPool,
  closePool: async () => {},
  sql: {},
}));

import { JobWorker, backgroundJobsDisabled } from "../../src/jobs/worker.js";

const previousSmoke = process.env.DEPLOY_SMOKE_MODE;
const previousDisable = process.env.DISABLE_BACKGROUND_JOBS;

function restoreFlags(): void {
  if (previousSmoke === undefined) {
    delete process.env.DEPLOY_SMOKE_MODE;
  } else {
    process.env.DEPLOY_SMOKE_MODE = previousSmoke;
  }
  if (previousDisable === undefined) {
    delete process.env.DISABLE_BACKGROUND_JOBS;
  } else {
    process.env.DISABLE_BACKGROUND_JOBS = previousDisable;
  }
}

afterEach(() => {
  restoreFlags();
  getPool.mockReset();
  vi.restoreAllMocks();
});

describe("background worker flags", () => {
  it("does not treat unset, empty, or explicit negatives as disabling polling", () => {
    expect(backgroundJobsDisabled({})).toBe(false);
    expect(backgroundJobsDisabled({ DEPLOY_SMOKE_MODE: "" })).toBe(false);
    expect(backgroundJobsDisabled({ DEPLOY_SMOKE_MODE: "false" })).toBe(false);
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: "0" })).toBe(false);
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: "off" })).toBe(false);
  });

  it("disables polling when either flag is set", () => {
    expect(backgroundJobsDisabled({ DEPLOY_SMOKE_MODE: "1" })).toBe(true);
    expect(backgroundJobsDisabled({ DEPLOY_SMOKE_MODE: "true" })).toBe(true);
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: "yes" })).toBe(true);
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: "on" })).toBe(true);
    expect(backgroundJobsDisabled({ DEPLOY_SMOKE_MODE: "false", DISABLE_BACKGROUND_JOBS: "1" })).toBe(true);
  });

  it("does not poll when DEPLOY_SMOKE_MODE or DISABLE_BACKGROUND_JOBS is set", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const worker = new JobWorker(loadConfig(testEnv({ JOB_POLL_INTERVAL_MS: "60000" })));

    process.env.DEPLOY_SMOKE_MODE = "1";
    delete process.env.DISABLE_BACKGROUND_JOBS;
    worker.start();
    await Promise.resolve();
    expect(worker.isPolling()).toBe(false);
    expect(getPool).not.toHaveBeenCalled();

    delete process.env.DEPLOY_SMOKE_MODE;
    process.env.DISABLE_BACKGROUND_JOBS = "true";
    worker.start();
    await Promise.resolve();
    expect(worker.isPolling()).toBe(false);
    expect(getPool).not.toHaveBeenCalled();
    worker.stop();
  });

  it("polls when neither flag is set", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.DEPLOY_SMOKE_MODE;
    delete process.env.DISABLE_BACKGROUND_JOBS;
    getPool.mockRejectedValue(new Error("no database in unit test"));

    const worker = new JobWorker(loadConfig(testEnv({ JOB_POLL_INTERVAL_MS: "60000" })));
    try {
      worker.start();
      expect(worker.isPolling()).toBe(true);
      await vi.waitFor(() => expect(getPool).toHaveBeenCalled());
    } finally {
      worker.stop();
    }
    expect(worker.isPolling()).toBe(false);
  });
});
