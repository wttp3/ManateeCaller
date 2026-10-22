import type { AppConfig } from "../config/index.js";
import { sql, getPool } from "../db/pool.js";
import { decryptString, encryptString, hmacHex, randomSlug } from "../utils/crypto.js";
import { combineTranscripts, transcriptToColor } from "../utils/color.js";
import { CONSENT_TEXT_VERSION } from "../interview/constants.js";
import { isPilotSenderAllowed, maskPhone } from "../pilot/allowlist.js";
import { normalizePhone, isValidE164 } from "../utils/phone.js";
import { logInfo } from "../utils/logger.js";

export class ParticipantService {
  constructor(private readonly config: AppConfig) {}

  phoneLookupHash(phone: string): string {
    return hmacHex(normalizePhone(phone), this.config.lookupHmacKey);
  }

  async isSuppressed(lookupHash: string): Promise<boolean> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("hash", sql.Char(64), lookupHash)
      .query(
        `SELECT 1 AS found FROM suppression_tokens
         WHERE phone_lookup_hash = @hash
           AND (expires_at IS NULL OR expires_at > SYSUTCDATETIME())`,
      );
    return result.recordset.length > 0;
  }

  async createParticipant(input: {
    name: string;
    phone: string;
    whatsappConsent: boolean;
    voiceConsent: boolean;
    privacyAccepted: boolean;
    ageConfirmed: boolean;
  }): Promise<{ participantId: string; sessionId: string }> {
    if (!input.ageConfirmed) {
      throw new Error("Age confirmation required");
    }
    if (!input.whatsappConsent || !input.voiceConsent || !input.privacyAccepted) {
      throw new Error("All consents required");
    }

    const phone = normalizePhone(input.phone);
    if (!isValidE164(phone)) {
      throw new Error("Invalid WhatsApp number");
    }

    const lookupHash = this.phoneLookupHash(phone);
    if (await this.isSuppressed(lookupHash)) {
      throw new Error("This number cannot be enrolled");
    }

    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const participantResult = await new sql.Request(transaction)
        .input("encrypted_phone", sql.NVarChar(512), encryptString(phone, this.config.dataEncryptionKey))
        .input("phone_lookup_hash", sql.Char(64), lookupHash)
        .input("encrypted_name", sql.NVarChar(512), encryptString(input.name.trim(), this.config.dataEncryptionKey))
        .query(`
          INSERT INTO participants (encrypted_phone, phone_lookup_hash, encrypted_name)
          OUTPUT INSERTED.id
          VALUES (@encrypted_phone, @phone_lookup_hash, @encrypted_name)
        `);

      const participantId = participantResult.recordset[0].id as string;

      const sessionResult = await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .query(`
          INSERT INTO interview_sessions (participant_id, state)
          OUTPUT INSERTED.id
          VALUES (@participant_id, 'pending_invite')
        `);

      const sessionId = sessionResult.recordset[0].id as string;

      if (this.config.whatsappTemplateInvitesEnabled && isPilotSenderAllowed(phone, this.config.pilotAllowedSenders)) {
        await new sql.Request(transaction)
          .input("participant_id", sql.UniqueIdentifier, participantId)
          .input("message_type", sql.NVarChar(64), "template_invite")
          .input(
            "payload_json",
            sql.NVarChar(sql.MAX),
            JSON.stringify({ templateName: this.config.whatsappTemplateName }),
          )
          .query(`
            INSERT INTO outbox_messages (participant_id, message_type, payload_json)
            VALUES (@participant_id, @message_type, @payload_json)
          `);
      } else if (this.config.whatsappTemplateInvitesEnabled) {
        logInfo("Not queueing template invite for a number outside the pilot allowlist", {
          to: maskPhone(phone),
        });
      }

      await transaction.commit();
      return { participantId, sessionId };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  /**
   * Message-first opt-in. Opens a session without a template.
   * Consent rows are recorded by the caller once the keyword is accepted.
   */
  async createFromKeyword(phone: string): Promise<{ participantId: string; sessionId: string }> {
    const normalized = normalizePhone(phone);
    if (!isValidE164(normalized)) {
      throw new Error("Invalid WhatsApp number");
    }
    if (!isPilotSenderAllowed(normalized, this.config.pilotAllowedSenders)) {
      throw new Error("This number is not on the pilot allowlist");
    }

    const lookupHash = this.phoneLookupHash(normalized);
    if (await this.isSuppressed(lookupHash)) {
      throw new Error("This number cannot be enrolled");
    }

    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const participantResult = await new sql.Request(transaction)
        .input("encrypted_phone", sql.NVarChar(512), encryptString(normalized, this.config.dataEncryptionKey))
        .input("phone_lookup_hash", sql.Char(64), lookupHash)
        .input("encrypted_name", sql.NVarChar(512), encryptString("", this.config.dataEncryptionKey))
        .query(`
          INSERT INTO participants (encrypted_phone, phone_lookup_hash, encrypted_name)
          OUTPUT INSERTED.id
          VALUES (@encrypted_phone, @phone_lookup_hash, @encrypted_name)
        `);

      const participantId = participantResult.recordset[0].id as string;

      const sessionResult = await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("hours", sql.Int, this.config.sessionTimeoutHours)
        .query(`
          INSERT INTO interview_sessions (participant_id, state, service_window_expires_at)
          OUTPUT INSERTED.id
          VALUES (@participant_id, 'awaiting_opt_in', DATEADD(hour, @hours, SYSUTCDATETIME()))
        `);

      const sessionId = sessionResult.recordset[0].id as string;
      await transaction.commit();
      return { participantId, sessionId };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  /** Consent is stored only after an allowlisted sender messages the keyword. */
  async recordKeywordConsents(participantId: string): Promise<void> {
    const pool = await getPool(this.config);
    const existing = await pool
      .request()
      .input("participant_id", sql.UniqueIdentifier, participantId)
      .query(`
        SELECT consent_type FROM consents
        WHERE participant_id = @participant_id AND withdrawn_at IS NULL
      `);
    const have = new Set(existing.recordset.map((row: { consent_type: string }) => row.consent_type));

    for (const consentType of ["whatsapp_contact", "voice_processing", "privacy_notice"] as const) {
      if (have.has(consentType)) {
        continue;
      }
      await pool
        .request()
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("consent_type", sql.NVarChar(64), consentType)
        .input("consent_text_version", sql.NVarChar(32), CONSENT_TEXT_VERSION)
        .query(`
          INSERT INTO consents (participant_id, consent_type, consent_text_version)
          VALUES (@participant_id, @consent_type, @consent_text_version)
        `);
    }
  }

  async getParticipantByLookup(lookupHash: string): Promise<{
    id: string;
    encryptedPhone: string;
    status: string;
  } | null> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("hash", sql.Char(64), lookupHash)
      .query(`
        SELECT TOP 1 id, encrypted_phone, status
        FROM participants
        WHERE phone_lookup_hash = @hash
      `);
    if (!result.recordset[0]) {
      return null;
    }
    return {
      id: result.recordset[0].id,
      encryptedPhone: result.recordset[0].encrypted_phone,
      status: result.recordset[0].status,
    };
  }

  async getParticipantById(participantId: string): Promise<{
    id: string;
    encryptedPhone: string;
    status: string;
    lookupHash: string;
  } | null> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, participantId)
      .query(`
        SELECT id, encrypted_phone, status, phone_lookup_hash
        FROM participants
        WHERE id = @id
      `);
    const row = result.recordset[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      encryptedPhone: row.encrypted_phone as string,
      status: row.status as string,
      lookupHash: row.phone_lookup_hash as string,
    };
  }

  async getSuppression(lookupHash: string): Promise<{ reason: string } | null> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("hash", sql.Char(64), lookupHash)
      .query(`
        SELECT reason
        FROM suppression_tokens
        WHERE phone_lookup_hash = @hash
          AND (expires_at IS NULL OR expires_at > SYSUTCDATETIME())
      `);
    const reason = result.recordset[0]?.reason as string | undefined;
    return reason ? { reason } : null;
  }

  async clearStopSuppression(lookupHash: string): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("hash", sql.Char(64), lookupHash)
      .query(`
        DELETE FROM suppression_tokens
        WHERE phone_lookup_hash = @hash AND reason = 'stop'
      `);
  }

  /**
   * Opt out in every state, including when there is no participant yet.
   * Pending invites and jobs are cancelled. A later opt-in keyword can clear a stop token.
   */
  async recordStop(participantId: string | null, lookupHash: string): Promise<void> {
    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("lookup_hash", sql.Char(64), lookupHash)
        .query(`
          UPDATE participants
          SET status = 'opted_out', updated_at = SYSUTCDATETIME()
          WHERE id = @participant_id;

          UPDATE interview_sessions
          SET state = 'opted_out', updated_at = SYSUTCDATETIME()
          WHERE participant_id = @participant_id
            AND state NOT IN ('complete');

          UPDATE consents
          SET withdrawn_at = SYSUTCDATETIME()
          WHERE participant_id = @participant_id
            AND withdrawn_at IS NULL;

          UPDATE outbox_messages
          SET status = 'cancelled'
          WHERE participant_id = @participant_id
            AND status = 'pending';

          UPDATE jobs
          SET status = 'cancelled',
              payload_json = N'{}',
              updated_at = SYSUTCDATETIME()
          WHERE participant_id = @participant_id
            AND status IN ('pending', 'processing');

          IF NOT EXISTS (SELECT 1 FROM suppression_tokens WHERE phone_lookup_hash = @lookup_hash)
            INSERT INTO suppression_tokens (phone_lookup_hash, reason)
            VALUES (@lookup_hash, 'stop');

          INSERT INTO compliance_records (phone_lookup_hash, action)
          VALUES (@lookup_hash, 'stop_received');
        `);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  /** Drop a stop suppression, mark the participant active, and open a new session. */
  async reopenAfterOptOut(participantId: string, lookupHash: string): Promise<string> {
    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("hash", sql.Char(64), lookupHash)
        .query(`
          DELETE FROM suppression_tokens
          WHERE phone_lookup_hash = @hash AND reason = 'stop'
        `);

      await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .query(`
          UPDATE participants
          SET status = 'active', updated_at = SYSUTCDATETIME()
          WHERE id = @participant_id
        `);

      const inserted = await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("hours", sql.Int, this.config.sessionTimeoutHours)
        .query(`
          INSERT INTO interview_sessions (participant_id, state, service_window_expires_at)
          OUTPUT INSERTED.id
          VALUES (@participant_id, 'awaiting_opt_in', DATEADD(hour, @hours, SYSUTCDATETIME()))
        `);

      const sessionId = inserted.recordset[0]?.id as string | undefined;
      if (!sessionId) {
        throw new Error("Failed to reopen session");
      }
      await transaction.commit();
      return sessionId;
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  async deleteWebhookEvents(lookupHash: string): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("lookup_hash", sql.Char(64), lookupHash)
      .query(`DELETE FROM webhook_events WHERE phone_lookup_hash = @lookup_hash`);
  }

  async deleteParticipant(participantId: string): Promise<void> {
    const pool = await getPool(this.config);
    const participant = await pool
      .request()
      .input("id", sql.UniqueIdentifier, participantId)
      .query(`SELECT phone_lookup_hash FROM participants WHERE id = @id`);

    const lookupHash = participant.recordset[0]?.phone_lookup_hash as string | undefined;
    if (!lookupHash) {
      return;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("lookup_hash", sql.Char(64), lookupHash)
        .query(`
          /* participant_erased */
          DELETE r FROM responses r
          INNER JOIN interview_sessions s ON s.id = r.session_id
          WHERE s.participant_id = @participant_id;

          UPDATE artwork_tiles
          SET session_id = NULL
          WHERE session_id IN (
            SELECT id FROM interview_sessions WHERE participant_id = @participant_id
          );

          DELETE FROM jobs WHERE participant_id = @participant_id;

          DELETE FROM interview_sessions WHERE participant_id = @participant_id;
          DELETE FROM consents WHERE participant_id = @participant_id;
          DELETE FROM outbox_messages WHERE participant_id = @participant_id;
          DELETE FROM webhook_events WHERE phone_lookup_hash = @lookup_hash;
          DELETE FROM participants WHERE id = @participant_id;

          IF EXISTS (SELECT 1 FROM suppression_tokens WHERE phone_lookup_hash = @lookup_hash)
            UPDATE suppression_tokens
            SET reason = 'erasure_request'
            WHERE phone_lookup_hash = @lookup_hash;
          ELSE
            INSERT INTO suppression_tokens (phone_lookup_hash, reason)
            VALUES (@lookup_hash, 'erasure_request');
        `);

      await new sql.Request(transaction)
        .input("lookup_hash", sql.Char(64), lookupHash)
        .input("action", sql.NVarChar(64), "participant_erased")
        .query(`
          INSERT INTO compliance_records (phone_lookup_hash, action)
          VALUES (@lookup_hash, @action)
        `);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
}

export class ArtworkService {
  constructor(private readonly config: AppConfig) {}

  async draftTile(sessionId: string): Promise<{ colorHex: string; publicSlug: string }> {
    const pool = await getPool(this.config);
    const responses = await pool
      .request()
      .input("session_id", sql.UniqueIdentifier, sessionId)
      .query(`
        SELECT question_index, encrypted_transcript
        FROM responses
        WHERE session_id = @session_id AND encrypted_transcript IS NOT NULL
        ORDER BY question_index ASC
      `);

    const transcripts: string[] = [];
    for (const row of responses.recordset) {
      transcripts.push(decryptString(row.encrypted_transcript as string, this.config.dataEncryptionKey));
    }

    if (transcripts.length === 0) {
      throw new Error("No transcripts to finalize");
    }

    const combined = combineTranscripts(transcripts);
    return {
      colorHex: transcriptToColor(combined, this.config.tileHmacKey),
      publicSlug: randomSlug(12),
    };
  }

  async persistTile(sessionId: string, tile: { colorHex: string; publicSlug: string }): Promise<void> {
    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("session_id", sql.UniqueIdentifier, sessionId)
        .input("color_hex", sql.Char(7), tile.colorHex)
        .input("public_slug", sql.Char(12), tile.publicSlug)
        .query(`
          INSERT INTO artwork_tiles (session_id, color_hex, public_slug)
          VALUES (@session_id, @color_hex, @public_slug);

          UPDATE responses SET encrypted_transcript = NULL WHERE session_id = @session_id;

          UPDATE interview_sessions
          SET state = 'complete', completed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
          WHERE id = @session_id;
        `);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  async finalizeSession(sessionId: string): Promise<string> {
    const tile = await this.draftTile(sessionId);
    await this.persistTile(sessionId, tile);
    return tile.publicSlug;
  }

  async listTiles(limit = 500): Promise<Array<{ colorHex: string; publicSlug: string; createdAt: string }>> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit) color_hex, public_slug, created_at
        FROM artwork_tiles
        ORDER BY created_at DESC
      `);
    return result.recordset.map((row: { color_hex: string; public_slug: string; created_at: Date }) => ({
      colorHex: row.color_hex,
      publicSlug: row.public_slug,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
