import type { AppConfig } from "../config/index.js";
import { sql, getPool } from "../db/pool.js";
import { encryptString } from "../utils/crypto.js";
import {
  PROMPTS,
  nextStateAfterOptIn,
  stateAfterIntroSent,
  stateAfterVoiceAnswer,
  promptForState,
  questionIndexForState,
  type InterviewState,
} from "../interview/constants.js";
import { ParticipantService } from "./participant.service.js";
import { WhatsAppService } from "./whatsapp.service.js";
import { ElevenLabsService } from "./elevenlabs.service.js";
import { ArtworkService } from "./participant.service.js";
import { JobService } from "./job.service.js";

export class InterviewService {
  private readonly participants: ParticipantService;
  private readonly whatsapp: WhatsAppService;
  private readonly elevenLabs: ElevenLabsService;
  private readonly artwork: ArtworkService;
  private readonly jobs: JobService;

  constructor(private readonly config: AppConfig) {
    this.participants = new ParticipantService(config);
    this.whatsapp = new WhatsAppService(config);
    this.elevenLabs = new ElevenLabsService(config);
    this.artwork = new ArtworkService(config);
    this.jobs = new JobService(config);
  }

  async handleInboundMessage(input: {
    from: string;
    type: string;
    text?: string;
    buttonReplyId?: string;
    mediaId?: string;
    messageId: string;
  }): Promise<void> {
    const lookupHash = this.participants.phoneLookupHash(input.from);
    const participant = await this.participants.getParticipantByLookup(lookupHash);
    if (!participant || participant.status !== "active") {
      return;
    }

    const phone = this.whatsapp.decryptPhone(participant.encryptedPhone);
    const session = await this.getActiveSession(participant.id);
    if (!session) {
      return;
    }

    if (this.isStopMessage(input)) {
      await this.handleOptOut(participant.id, phone, lookupHash);
      return;
    }

    await this.touchServiceWindow(session.id);

    if (input.buttonReplyId === "IM_IN" || input.text?.trim().toLowerCase() === "i'm in") {
      await this.handleOptIn(session, phone);
      return;
    }

    if (input.type === "audio" && input.mediaId) {
      await this.jobs.enqueue("process_voice_note", {
        sessionId: session.id,
        participantId: participant.id,
        mediaId: input.mediaId,
        messageId: input.messageId,
      });
      return;
    }

    if (session.state.startsWith("awaiting_voice")) {
      await this.whatsapp.sendText(phone, PROMPTS.wrongMedia);
    }
  }

  async processVoiceNote(payload: {
    sessionId: string;
    participantId: string;
    mediaId: string;
  }): Promise<void> {
    const pool = await getPool(this.config);
    const sessionRow = await pool
      .request()
      .input("id", sql.UniqueIdentifier, payload.sessionId)
      .query(`SELECT state, participant_id FROM interview_sessions WHERE id = @id`);

    const state = sessionRow.recordset[0]?.state as InterviewState | undefined;
    if (!state) {
      throw new Error("Session not found");
    }

    const questionIndex = questionIndexForState(state);
    if (questionIndex === null) {
      throw new Error("Session not awaiting voice note");
    }

    const participant = await pool
      .request()
      .input("id", sql.UniqueIdentifier, payload.participantId)
      .query(`SELECT encrypted_phone FROM participants WHERE id = @id`);

    const phone = this.whatsapp.decryptPhone(participant.recordset[0].encrypted_phone as string);

    const { buffer } = await this.whatsapp.downloadMedia(payload.mediaId);
    if (buffer.length > this.config.maxVoiceNoteBytes) {
      throw new Error("Voice note too large");
    }

    const tempPath = this.elevenLabs.writeTempFile(buffer, payload.mediaId);
    let transcript = "";
    try {
      transcript = await this.elevenLabs.transcribeAudio(buffer, `${payload.mediaId}.ogg`);
    } finally {
      this.elevenLabs.deleteTempFile(tempPath);
      await this.whatsapp.deleteMedia(payload.mediaId);
    }

    await pool
      .request()
      .input("session_id", sql.UniqueIdentifier, payload.sessionId)
      .input("question_index", sql.Int, questionIndex)
      .input(
        "encrypted_transcript",
        sql.NVarChar(sql.MAX),
        encryptString(transcript, this.config.dataEncryptionKey),
      )
      .input("whatsapp_media_id", sql.NVarChar(128), payload.mediaId)
      .query(`
        MERGE responses AS target
        USING (SELECT @session_id AS session_id, @question_index AS question_index) AS source
        ON target.session_id = source.session_id AND target.question_index = source.question_index
        WHEN MATCHED THEN
          UPDATE SET encrypted_transcript = @encrypted_transcript, whatsapp_media_id = @whatsapp_media_id, processed_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (session_id, question_index, encrypted_transcript, whatsapp_media_id, processed_at)
          VALUES (@session_id, @question_index, @encrypted_transcript, @whatsapp_media_id, SYSUTCDATETIME());
      `);

    const nextState = stateAfterVoiceAnswer(state, questionIndex);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, payload.sessionId)
      .input("state", sql.NVarChar(64), nextState)
      .input("current_question_index", sql.Int, questionIndex + 1)
      .query(`
        UPDATE interview_sessions
        SET state = @state, current_question_index = @current_question_index, updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);

    if (nextState === "processing") {
      await this.jobs.enqueue("finalize_interview", { sessionId: payload.sessionId, phone });
      return;
    }

    const nextPrompt = promptForState(nextState);
    if (nextPrompt) {
      await this.whatsapp.sendText(phone, nextPrompt);
    }
  }

  async finalizeInterview(payload: { sessionId: string; phone: string }): Promise<void> {
    const slug = await this.artwork.finalizeSession(payload.sessionId);
    await this.whatsapp.sendText(
      payload.phone,
      PROMPTS.complete(slug, this.config.publicBaseUrl),
    );
  }

  async processOutbox(): Promise<void> {
    const pool = await getPool(this.config);
    const pending = await pool.request().query(`
      SELECT TOP (10) o.id, o.participant_id, o.message_type, o.payload_json, o.attempts, p.encrypted_phone
      FROM outbox_messages o
      INNER JOIN participants p ON p.id = o.participant_id
      WHERE o.status = 'pending'
      ORDER BY o.created_at ASC
    `);

    for (const row of pending.recordset) {
      const phone = this.whatsapp.decryptPhone(row.encrypted_phone as string);
      const payload = JSON.parse(row.payload_json as string) as { templateName?: string };

      try {
        if (row.message_type === "template_invite") {
          await this.whatsapp.sendTemplate(phone, payload.templateName ?? this.config.whatsappTemplateName);
        }

        await pool
          .request()
          .input("id", sql.UniqueIdentifier, row.id)
          .query(`
            UPDATE outbox_messages SET status = 'sent', sent_at = SYSUTCDATETIME() WHERE id = @id
          `);

        await pool
          .request()
          .input("participant_id", sql.UniqueIdentifier, row.participant_id)
          .query(`
            UPDATE interview_sessions
            SET state = 'awaiting_opt_in', updated_at = SYSUTCDATETIME()
            WHERE participant_id = @participant_id AND state = 'pending_invite'
          `);
      } catch (err) {
        await pool
          .request()
          .input("id", sql.UniqueIdentifier, row.id)
          .input("attempts", sql.Int, (row.attempts ?? 0) + 1)
          .query(`
            UPDATE outbox_messages SET attempts = @attempts WHERE id = @id
          `);
        throw err;
      }
    }
  }

  private async getActiveSession(participantId: string): Promise<{ id: string; state: InterviewState } | null> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("participant_id", sql.UniqueIdentifier, participantId)
      .query(`
        SELECT TOP 1 id, state
        FROM interview_sessions
        WHERE participant_id = @participant_id
          AND state NOT IN ('complete', 'opted_out', 'expired')
        ORDER BY created_at DESC
      `);
    if (!result.recordset[0]) {
      return null;
    }
    return { id: result.recordset[0].id, state: result.recordset[0].state };
  }

  private async touchServiceWindow(sessionId: string): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .input("hours", sql.Int, this.config.sessionTimeoutHours)
      .query(`
        UPDATE interview_sessions
        SET service_window_expires_at = DATEADD(hour, @hours, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);
  }

  private async handleOptIn(
    session: { id: string; state: InterviewState },
    phone: string,
  ): Promise<void> {
    const next = nextStateAfterOptIn(session.state);
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, session.id)
      .input("state", sql.NVarChar(64), stateAfterIntroSent())
      .query(`
        UPDATE interview_sessions SET state = @state, updated_at = SYSUTCDATETIME() WHERE id = @id
      `);

    await this.whatsapp.sendText(phone, PROMPTS.intro);
    const firstQuestion = promptForState(stateAfterIntroSent());
    if (firstQuestion) {
      await this.whatsapp.sendText(phone, firstQuestion);
    }
    void next;
  }

  private async handleOptOut(participantId: string, phone: string, lookupHash: string): Promise<void> {
    const pool = await getPool(this.config);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("participant_id", sql.UniqueIdentifier, participantId)
        .input("lookup_hash", sql.Char(64), lookupHash)
        .query(`
          UPDATE participants SET status = 'opted_out', updated_at = SYSUTCDATETIME() WHERE id = @participant_id;
          UPDATE interview_sessions SET state = 'opted_out', updated_at = SYSUTCDATETIME()
          WHERE participant_id = @participant_id AND state NOT IN ('complete');
          UPDATE consents SET withdrawn_at = SYSUTCDATETIME()
          WHERE participant_id = @participant_id AND withdrawn_at IS NULL;
          IF NOT EXISTS (SELECT 1 FROM suppression_tokens WHERE phone_lookup_hash = @lookup_hash)
            INSERT INTO suppression_tokens (phone_lookup_hash, reason) VALUES (@lookup_hash, 'stop');
          INSERT INTO compliance_records (phone_lookup_hash, action) VALUES (@lookup_hash, 'stop_received');
        `);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    await this.whatsapp.sendText(phone, PROMPTS.optOut);
  }

  private isStopMessage(input: { text?: string; buttonReplyId?: string }): boolean {
    const text = input.text?.trim().toUpperCase();
    return text === "STOP" || text === "UNSUBSCRIBE";
  }
}
