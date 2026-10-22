import type { AppConfig } from "../config/index.js";
import { sql, getPool } from "../db/pool.js";
import { encryptString } from "../utils/crypto.js";
import {
  PROMPTS,
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
import { JobService, sanitiseStoredError } from "./job.service.js";
import { expiredNoticeBody, isServiceWindowOpen } from "../interview/service-window.js";
import { INBOUND_IGNORED_MESSAGE, isPilotSenderAllowed, maskPhone } from "../pilot/allowlist.js";
import { isErasureCommand, isStopCommand } from "../pilot/commands.js";
import { isOptInMessage } from "../pilot/opt-in.js";
import { normalizePhone } from "../utils/phone.js";
import { logError, logInfo } from "../utils/logger.js";

export const OUTBOX_MAX_ATTEMPTS = 5;

type SendGate = { blocked: true; phone: null } | { blocked: false; phone: string };

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
    const phone = normalizePhone(input.from);
    if (!isPilotSenderAllowed(phone, this.config.pilotAllowedSenders)) {
      logInfo(INBOUND_IGNORED_MESSAGE, { from: maskPhone(phone) });
      return;
    }

    const lookupHash = this.participants.phoneLookupHash(phone);

    if (isStopCommand(input)) {
      await this.handleStop(lookupHash);
      return;
    }

    if (isErasureCommand(input, this.config.erasureKeyword)) {
      await this.handleErasure(lookupHash);
      return;
    }

    const participant = await this.participants.getParticipantByLookup(lookupHash);
    if (!participant || participant.status !== "active") {
      if (
        isOptInMessage(input, this.config.optInKeyword, {
          templateInvitesEnabled: this.config.whatsappTemplateInvitesEnabled,
          participantExists: Boolean(participant),
        })
      ) {
        await this.handleOptInKeyword(phone, lookupHash, participant);
      }
      return;
    }

    const storedPhone = this.whatsapp.decryptPhone(participant.encryptedPhone);
    const session = await this.getActiveSession(participant.id);
    if (!session) {
      return;
    }

    await this.touchServiceWindow(session.id);

    if (
      isOptInMessage(input, this.config.optInKeyword, {
        templateInvitesEnabled: this.config.whatsappTemplateInvitesEnabled,
        participantExists: true,
      })
    ) {
      if (
        session.state === "pending_invite" ||
        session.state === "invited" ||
        session.state === "awaiting_opt_in"
      ) {
        await this.handleOptIn(session, storedPhone, participant.id);
      }
      return;
    }

    if (input.type === "audio" && input.mediaId) {
      await this.jobs.enqueue("process_voice_note", {
        sessionId: session.id,
        participantId: participant.id,
        mediaId: input.mediaId,
      });
      return;
    }

    if (session.state.startsWith("awaiting_voice")) {
      await this.whatsapp.sendText(storedPhone, PROMPTS.wrongMedia);
    }
  }

  async processVoiceNote(payload: {
    sessionId: string;
    participantId: string;
    mediaId: string;
  }): Promise<void> {
    const gate = await this.sendingBlocked(payload.participantId);
    if (gate.blocked) {
      logInfo("Skipping voice note because the participant is opted out or blocked");
      return;
    }

    const pool = await getPool(this.config);
    const sessionRow = await pool
      .request()
      .input("id", sql.UniqueIdentifier, payload.sessionId)
      .query(`
        SELECT state, participant_id, service_window_expires_at
        FROM interview_sessions
        WHERE id = @id
      `);

    const state = sessionRow.recordset[0]?.state as InterviewState | undefined;
    if (!state) {
      throw new Error("Session not found");
    }
    if (state === "opted_out" || state === "expired" || state === "complete") {
      return;
    }

    const questionIndex = questionIndexForState(state);
    if (questionIndex === null) {
      throw new Error("Session not awaiting voice note");
    }

    const phone = gate.phone;
    if (!isServiceWindowOpen(sessionRow.recordset[0].service_window_expires_at as Date | null)) {
      await this.expireSession(payload.sessionId, phone);
      return;
    }

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

    if ((await this.sendingBlocked(payload.participantId)).blocked) {
      logInfo("Dropping voice note result because the participant opted out or was blocked");
      return;
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
    if (!(await this.sendFreeFormIfWindowOpen(payload.sessionId, phone, nextState, payload.participantId))) {
      return;
    }

    await this.advanceSession(payload.sessionId, nextState, questionIndex + 1);

    if (nextState === "processing") {
      if ((await this.sendingBlocked(payload.participantId)).blocked) {
        return;
      }
      await this.jobs.enqueue("finalize_interview", {
        sessionId: payload.sessionId,
        participantId: payload.participantId,
      });
    }
  }

  async finalizeInterview(payload: { sessionId: string; participantId?: string }): Promise<void> {
    const participantId = payload.participantId ?? (await this.participantIdForSession(payload.sessionId));
    if (!participantId) {
      throw new Error("Session not found");
    }

    const gate = await this.sendingBlocked(participantId);
    if (gate.blocked) {
      logInfo("Skipping mosaic send because the participant is opted out or blocked");
      return;
    }

    if (!(await this.serviceWindowOpen(payload.sessionId))) {
      await this.expireSession(payload.sessionId, gate.phone);
      return;
    }

    const tile = await this.artwork.draftTile(payload.sessionId);
    const body = PROMPTS.complete(tile.publicSlug, this.config.publicBaseUrl);
    const again = await this.sendingBlocked(participantId);
    if (again.blocked) {
      return;
    }
    if (!(await this.serviceWindowOpen(payload.sessionId))) {
      await this.expireSession(payload.sessionId, again.phone);
      return;
    }
    await this.whatsapp.sendText(again.phone, body);
    await this.artwork.persistTile(payload.sessionId, tile);
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
      try {
        await this.deliverOutboxRow(pool, row);
      } catch (err) {
        await this.recordOutboxFailure(pool, row, err);
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
          AND state NOT IN ('opted_out', 'expired', 'complete')
      `);
  }

  private async handleOptInKeyword(
    phone: string,
    lookupHash: string,
    participant: { id: string; encryptedPhone: string; status: string } | null,
  ): Promise<void> {
    if (!participant) {
      await this.participants.clearKeywordSuppression(lookupHash);
      await this.startKeywordOptIn(phone);
      return;
    }

    if (participant.status === "opted_out") {
      const sessionId = await this.participants.reopenAfterOptOut(participant.id, lookupHash);
      const storedPhone = this.whatsapp.decryptPhone(participant.encryptedPhone);
      await this.handleOptIn({ id: sessionId, state: "awaiting_opt_in" }, storedPhone, participant.id);
    }
  }

  private async startKeywordOptIn(phone: string): Promise<void> {
    const lookupHash = this.participants.phoneLookupHash(phone);
    if (await this.participants.isSuppressed(lookupHash)) {
      logInfo("Ignoring opt-in keyword from a suppressed number", { from: maskPhone(phone) });
      return;
    }
    const created = await this.participants.createFromKeyword(phone);
    await this.handleOptIn({ id: created.sessionId, state: "awaiting_opt_in" }, phone, created.participantId);
  }

  private async handleOptIn(
    session: { id: string; state: InterviewState },
    phone: string,
    participantId: string,
  ): Promise<void> {
    await this.participants.recordKeywordConsents(participantId);
    await this.whatsapp.sendText(phone, PROMPTS.intro);
    const firstQuestion = promptForState(stateAfterIntroSent());
    if (firstQuestion) {
      await this.whatsapp.sendText(phone, firstQuestion);
    }

    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, session.id)
      .input("state", sql.NVarChar(64), stateAfterIntroSent())
      .query(`
        UPDATE interview_sessions
        SET state = @state, updated_at = SYSUTCDATETIME()
        WHERE id = @id
          AND state NOT IN ('opted_out', 'expired', 'complete')
      `);
  }

  /**
   * STOP is honoured with or without a session. The confirmation is one free-form
   * message. It is sent only when this call is the one that opts the participant
   * out and a stored 24-hour window was open in that same transaction.
   */
  private async handleStop(lookupHash: string): Promise<void> {
    const participant = await this.participants.getParticipantByLookup(lookupHash);
    const { sendConfirmation } = await this.participants.recordStop(participant?.id ?? null, lookupHash);
    if (!sendConfirmation || !participant) {
      return;
    }
    const storedPhone = this.whatsapp.decryptPhone(participant.encryptedPhone);
    await this.whatsapp.sendText(storedPhone, PROMPTS.optOut, { bypassOptOut: true });
  }

  /**
   * Erasure only runs for the number that sent the keyword, or for an admin with
   * the bearer token. Media files are deleted first, best effort. One confirmation
   * is sent when the window is open.
   */
  async eraseParticipant(participantId: string): Promise<void> {
    const mediaIds = await this.participants.listMediaIds(participantId);
    for (const mediaId of mediaIds) {
      try {
        await this.whatsapp.deleteMedia(mediaId);
      } catch (err) {
        logError("Failed to delete WhatsApp media during erasure", {
          error: sanitiseStoredError(err instanceof Error ? err.message : "unknown"),
        });
      }
    }
    await this.participants.deleteParticipant(participantId);
  }

  private async handleErasure(lookupHash: string): Promise<void> {
    const participant = await this.participants.getParticipantByLookup(lookupHash);
    if (!participant) {
      await this.participants.deleteWebhookEvents(lookupHash);
      return;
    }
    const windowOpen = await this.anyServiceWindowOpen(participant.id);
    const storedPhone = this.whatsapp.decryptPhone(participant.encryptedPhone);
    await this.eraseParticipant(participant.id);
    if (windowOpen) {
      await this.whatsapp.sendText(storedPhone, PROMPTS.erased, { bypassOptOut: true });
    }
  }

  private async anyServiceWindowOpen(participantId: string): Promise<boolean> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("participant_id", sql.UniqueIdentifier, participantId)
      .query(`
        SELECT service_window_expires_at
        FROM interview_sessions
        WHERE participant_id = @participant_id
      `);
    return result.recordset.some((row) =>
      isServiceWindowOpen(row.service_window_expires_at as Date | null | undefined),
    );
  }

  private async participantIdForSession(sessionId: string): Promise<string | null> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .query(`
        SELECT participant_id
        FROM interview_sessions
        WHERE id = @id
      `);
    const id = result.recordset[0]?.participant_id as string | undefined;
    return id ?? null;
  }

  /** Recheck opt-out, suppression, and the pilot allowlist immediately before a send. */
  private async sendingBlocked(participantId: string): Promise<SendGate> {
    const participant = await this.participants.getParticipantById(participantId);
    if (!participant || participant.status !== "active") {
      return { blocked: true, phone: null };
    }
    if (await this.participants.isSuppressed(participant.lookupHash)) {
      return { blocked: true, phone: null };
    }
    const phone = this.whatsapp.decryptPhone(participant.encryptedPhone);
    if (!isPilotSenderAllowed(phone, this.config.pilotAllowedSenders)) {
      return { blocked: true, phone: null };
    }
    return { blocked: false, phone };
  }

  private async serviceWindowOpen(sessionId: string): Promise<boolean> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .query(`
        SELECT service_window_expires_at
        FROM interview_sessions
        WHERE id = @id
      `);
    return isServiceWindowOpen(result.recordset[0]?.service_window_expires_at as Date | null | undefined);
  }

  /**
   * Mark the session expired. The expired prompt is free-form, so it is sent
   * only while the customer-service window is still open and dropped otherwise.
   */
  private async expireSession(sessionId: string, phone: string): Promise<void> {
    const pool = await getPool(this.config);
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .query(`
        SELECT service_window_expires_at
        FROM interview_sessions
        WHERE id = @id
      `);
    const notice = expiredNoticeBody(result.recordset[0]?.service_window_expires_at as Date | null | undefined);
    if (notice) {
      await this.whatsapp.sendText(phone, notice);
    }
    await this.markSessionExpired(sessionId);
  }

  private async markSessionExpired(sessionId: string): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .query(`
        UPDATE interview_sessions
        SET state = 'expired', updated_at = SYSUTCDATETIME()
        WHERE id = @id AND state NOT IN ('complete', 'opted_out', 'expired')
      `);
  }

  /**
   * Send the next free-form question only inside an open window.
   * Returns false when the session was expired and nothing was sent.
   * A processing transition has no prompt here; the mosaic link is sent later.
   */
  private async sendFreeFormIfWindowOpen(
    sessionId: string,
    phone: string,
    nextState: InterviewState,
    participantId: string,
  ): Promise<boolean> {
    if ((await this.sendingBlocked(participantId)).blocked) {
      return false;
    }
    if (!(await this.serviceWindowOpen(sessionId))) {
      await this.expireSession(sessionId, phone);
      return false;
    }
    if (nextState === "processing") {
      return true;
    }
    const nextPrompt = promptForState(nextState);
    if (nextPrompt) {
      await this.whatsapp.sendText(phone, nextPrompt);
    }
    return true;
  }

  private async advanceSession(sessionId: string, nextState: InterviewState, questionIndex: number): Promise<void> {
    const pool = await getPool(this.config);
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, sessionId)
      .input("state", sql.NVarChar(64), nextState)
      .input("current_question_index", sql.Int, questionIndex)
      .query(`
        UPDATE interview_sessions
        SET state = @state, current_question_index = @current_question_index, updated_at = SYSUTCDATETIME()
        WHERE id = @id
          AND state NOT IN ('opted_out', 'expired', 'complete')
      `);
  }

  private async deliverOutboxRow(
    pool: Awaited<ReturnType<typeof getPool>>,
    row: {
      id: string;
      participant_id: string;
      message_type: string;
      payload_json: string;
      encrypted_phone: string;
    },
  ): Promise<void> {
    const gate = await this.sendingBlocked(row.participant_id);
    if (gate.blocked) {
      await this.cancelOutbox(pool, row.id);
      logInfo("Cancelling outbox message because the participant is opted out or blocked", {
        messageType: row.message_type,
      });
      return;
    }

    const phone = gate.phone;
    const payload = JSON.parse(row.payload_json) as { templateName?: string };

    if (row.message_type === "template_invite") {
      if (!this.config.whatsappTemplateInvitesEnabled) {
        await pool
          .request()
          .input("id", sql.UniqueIdentifier, row.id)
          .query(`UPDATE outbox_messages SET status = 'skipped' WHERE id = @id AND status = 'pending'`);
        logInfo("Skipping WhatsApp template invite because template invites are disabled");
        return;
      }
      await this.whatsapp.sendTemplate(phone, payload.templateName ?? this.config.whatsappTemplateName);
    }

    await pool
      .request()
      .input("id", sql.UniqueIdentifier, row.id)
      .query(`
        UPDATE outbox_messages
        SET status = 'sent', sent_at = SYSUTCDATETIME()
        WHERE id = @id AND status = 'pending'
      `);

    await pool
      .request()
      .input("participant_id", sql.UniqueIdentifier, row.participant_id)
      .query(`
        UPDATE interview_sessions
        SET state = 'awaiting_opt_in', updated_at = SYSUTCDATETIME()
        WHERE participant_id = @participant_id AND state = 'pending_invite'
      `);
  }

  private async cancelOutbox(pool: Awaited<ReturnType<typeof getPool>>, outboxId: string): Promise<void> {
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, outboxId)
      .query(`UPDATE outbox_messages SET status = 'cancelled' WHERE id = @id AND status = 'pending'`);
  }

  private async recordOutboxFailure(
    pool: Awaited<ReturnType<typeof getPool>>,
    row: { id: string; message_type: string; attempts?: number },
    err: unknown,
  ): Promise<void> {
    const attempts = Number(row.attempts ?? 0) + 1;
    const status = attempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : "pending";
    try {
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, row.id)
        .input("attempts", sql.Int, attempts)
        .input("status", sql.NVarChar(32), status)
        .query(`
          UPDATE outbox_messages
          SET attempts = @attempts, status = @status
          WHERE id = @id AND status = 'pending'
        `);
    } catch (updateErr) {
      logError("Failed to record outbox attempt", {
        messageType: row.message_type,
        error: updateErr instanceof Error ? updateErr.message : "unknown",
      });
    }
    logError("Outbox message failed", {
      messageType: row.message_type,
      attempts,
      status,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}
