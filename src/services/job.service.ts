import { createHash } from "node:crypto";
import type { AppConfig } from "../config/index.js";
import { sql, getPool } from "../db/pool.js";

export type JobType = "process_voice_note" | "finalize_interview" | "send_outbox";

const PHONE_PAYLOAD_KEYS = new Set(["phone", "to", "from", "msisdn", "encryptedphone", "encrypted_phone"]);

/** Job rows are durable. A phone number in one of them is personal data at rest. */
export function assertPayloadHasNoPhone(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (PHONE_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new Error("Job payload must not include a phone number");
    }
    if (typeof value === "string" && /\+[1-9]\d{7,14}/.test(value)) {
      throw new Error("Job payload must not include a phone number");
    }
  }
}

export class JobService {
  constructor(private readonly config: AppConfig) {}

  async enqueue(jobType: JobType, payload: Record<string, unknown>, runAfter?: Date): Promise<void> {
    assertPayloadHasNoPhone(payload);
    const participantId = typeof payload.participantId === "string" ? payload.participantId : null;
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("job_type", sql.NVarChar(64), jobType)
      .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .input("run_after", sql.DateTime2, runAfter ?? new Date())
      .input("participant_id", sql.UniqueIdentifier, participantId)
      .query(`
        INSERT INTO jobs (job_type, payload_json, run_after, participant_id)
        VALUES (@job_type, @payload_json, @run_after, @participant_id)
      `);
  }

  async claimNext(workerId: string): Promise<{
    id: string;
    jobType: JobType;
    payload: Record<string, unknown>;
  } | null> {
    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const result = await new sql.Request(transaction)
        .input("worker_id", sql.NVarChar(64), workerId)
        .query(`
          WITH next_job AS (
            SELECT TOP (1) id
            FROM jobs WITH (UPDLOCK, READPAST, ROWLOCK)
            WHERE status = 'pending'
              AND run_after <= SYSUTCDATETIME()
              AND (locked_until IS NULL OR locked_until <= SYSUTCDATETIME())
            ORDER BY run_after ASC
          )
          UPDATE jobs
          SET status = 'processing',
              locked_by = @worker_id,
              locked_until = DATEADD(minute, 5, SYSUTCDATETIME()),
              attempts = attempts + 1,
              updated_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id, INSERTED.job_type, INSERTED.payload_json
          WHERE id IN (SELECT id FROM next_job);
        `);

      if (!result.recordset[0]) {
        await transaction.commit();
        return null;
      }

      await transaction.commit();
      return {
        id: result.recordset[0].id,
        jobType: result.recordset[0].job_type,
        payload: JSON.parse(result.recordset[0].payload_json),
      };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  async complete(jobId: string): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, jobId)
      .query(`
        UPDATE jobs
        SET status = 'completed', locked_by = NULL, locked_until = NULL, updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);
  }

  async fail(jobId: string, error: string, retryMinutes = 2): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, jobId)
      .input("error", sql.NVarChar(512), error.slice(0, 512))
      .input("retry_minutes", sql.Int, retryMinutes)
      .query(`
        UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error = @error,
            locked_by = NULL,
            locked_until = NULL,
            run_after = DATEADD(minute, @retry_minutes, SYSUTCDATETIME()),
            updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);
  }

  async recordWebhook(eventKey: string, payload: unknown, phoneLookupHash?: string | null): Promise<boolean> {
    const pool = await getPool(this.config);
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    try {
      await pool
        .request()
        .input("event_key", sql.NVarChar(256), eventKey)
        .input("payload_hash", sql.Char(64), payloadHash)
        .input("phone_lookup_hash", sql.Char(64), phoneLookupHash ?? null)
        .query(`
          INSERT INTO webhook_events (event_key, payload_hash, phone_lookup_hash)
          VALUES (@event_key, @payload_hash, @phone_lookup_hash)
        `);
      return true;
    } catch {
      return false;
    }
  }
}
