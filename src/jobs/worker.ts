import { hostname } from "node:os";
import type { AppConfig } from "../config/index.js";
import { JobService } from "../services/job.service.js";
import { InterviewService } from "../services/interview.service.js";
import { logError, logInfo } from "../utils/logger.js";

export class JobWorker {
  private readonly jobs: JobService;
  private readonly interview: InterviewService;
  private readonly workerId = `${hostname()}-${process.pid}`;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: AppConfig) {
    this.jobs = new JobService(config);
    this.interview = new InterviewService(config);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.jobPollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.interview.processOutbox();
    } catch (err) {
      logError("Outbox processing failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }

    for (;;) {
      const job = await this.jobs.claimNext(this.workerId);
      if (!job) {
        break;
      }

      try {
        if (job.jobType === "process_voice_note") {
          await this.interview.processVoiceNote(job.payload as {
            sessionId: string;
            participantId: string;
            mediaId: string;
          });
        } else if (job.jobType === "finalize_interview") {
          await this.interview.finalizeInterview(job.payload as { sessionId: string; phone: string });
        }
        await this.jobs.complete(job.id);
        logInfo("Job completed", { jobType: job.jobType });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        await this.jobs.fail(job.id, message);
        logError("Job failed", { jobType: job.jobType, error: message });
      }
    }
  }
}
