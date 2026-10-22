import { randomUUID } from "node:crypto";

export type MemoryParticipant = {
  id: string;
  encrypted_phone: string;
  phone_lookup_hash: string;
  encrypted_name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type MemoryConsent = {
  id: string;
  participant_id: string;
  consent_type: string;
  consent_text_version: string;
  granted_at: Date;
  withdrawn_at: Date | null;
};

export type MemorySession = {
  id: string;
  participant_id: string;
  state: string;
  current_question_index: number;
  service_window_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

export type MemoryOutbox = {
  id: string;
  participant_id: string;
  message_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
};

export type MemoryResponse = {
  session_id: string;
  question_index: number;
  encrypted_transcript: string | null;
  whatsapp_media_id?: string | null;
};

export type MemoryTile = {
  session_id: string | null;
  color_hex: string;
  public_slug: string;
};

export type MemoryJob = {
  id: string;
  job_type: string;
  payload_json: string;
  participant_id: string | null;
  status: string;
  attempts?: number;
  max_attempts?: number;
  last_error?: string | null;
};

export type MemoryWebhook = {
  event_key: string;
  payload_hash: string;
  phone_lookup_hash: string | null;
};

export type MemorySuppression = {
  phone_lookup_hash: string;
  reason: string;
  expires_at: Date | null;
};

export type MemoryCompliance = {
  phone_lookup_hash: string;
  action: string;
};

export type MemoryStore = {
  participants: MemoryParticipant[];
  consents: MemoryConsent[];
  sessions: MemorySession[];
  outbox: MemoryOutbox[];
  responses: MemoryResponse[];
  artwork: MemoryTile[];
  jobs: MemoryJob[];
  webhookEvents: MemoryWebhook[];
  suppression: MemorySuppression[];
  compliance: MemoryCompliance[];
};

export const memoryDebug = {
  errors: [] as string[],
};

let committed: MemoryStore = emptyStore();
let transactionChain: Promise<void> = Promise.resolve();

function emptyStore(): MemoryStore {
  return {
    participants: [],
    consents: [],
    sessions: [],
    outbox: [],
    responses: [],
    artwork: [],
    jobs: [],
    webhookEvents: [],
    suppression: [],
    compliance: [],
  };
}

function cloneStore(store: MemoryStore): MemoryStore {
  return structuredClone(store);
}

export function resetMemory(): void {
  committed = emptyStore();
  memoryDebug.errors = [];
  transactionChain = Promise.resolve();
}

export function memorySnapshot(): MemoryStore {
  return committed;
}

function compact(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim().toLowerCase();
}

function hoursFrom(inputs: Map<string, unknown>): number {
  const hours = Number(inputs.get("hours") ?? 24);
  return Number.isFinite(hours) ? hours : 24;
}

function windowFrom(inputs: Map<string, unknown>): Date {
  return new Date(Date.now() + hoursFrom(inputs) * 60 * 60 * 1000);
}

function fail(sqlText: string): never {
  const message = `Unhandled memory SQL: ${compact(sqlText)}`;
  memoryDebug.errors.push(message);
  throw new Error(message);
}

function payloadField(payloadJson: string, key: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const value = payload[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Same ownership rule as the STOP and erasure SQL:
 * jobs.participant_id, payload participantId, or payload sessionId for this participant.
 */
function jobOwnedByParticipant(store: MemoryStore, job: MemoryJob, participantId: string): boolean {
  if (job.participant_id === participantId) {
    return true;
  }
  if (payloadField(job.payload_json, "participantId") === participantId) {
    return true;
  }
  const sessionId = payloadField(job.payload_json, "sessionId");
  if (!sessionId) {
    return false;
  }
  return store.sessions.some((session) => session.id === sessionId && session.participant_id === participantId);
}

function applyStop(inputs: Map<string, unknown>, store: MemoryStore): { recordset: Array<Record<string, unknown>> } {
  const participantId = inputs.get("participant_id");
  const hash = String(inputs.get("lookup_hash") ?? "");
  let transitioned = false;
  let windowOpen = false;
  if (typeof participantId === "string" && participantId.length > 0) {
    windowOpen = store.sessions.some(
      (session) =>
        session.participant_id === participantId &&
        session.service_window_expires_at !== null &&
        session.service_window_expires_at.getTime() > Date.now(),
    );
    const participant = store.participants.find((item) => item.id === participantId);
    if (participant && participant.status !== "opted_out") {
      participant.status = "opted_out";
      participant.updated_at = new Date();
      transitioned = true;
    }
    for (const session of store.sessions) {
      if (session.participant_id === participantId && session.state !== "complete") {
        session.state = "opted_out";
        session.updated_at = new Date();
      }
    }
    for (const consent of store.consents) {
      if (consent.participant_id === participantId && consent.withdrawn_at === null) {
        consent.withdrawn_at = new Date();
      }
    }
    for (const row of store.outbox) {
      if (row.participant_id === participantId && row.status === "pending") {
        row.status = "cancelled";
      }
    }
    for (const job of store.jobs) {
      if (
        jobOwnedByParticipant(store, job, participantId) &&
        (job.status === "pending" || job.status === "processing")
      ) {
        job.status = "cancelled";
        job.payload_json = "{}";
      }
    }
  }
  if (hash && !store.suppression.some((item) => item.phone_lookup_hash === hash)) {
    store.suppression.push({ phone_lookup_hash: hash, reason: "stop", expires_at: null });
  }
  if (hash) {
    store.compliance.push({ phone_lookup_hash: hash, action: "stop_received" });
  }
  return {
    recordset: [{ transitioned: transitioned ? 1 : 0, window_open: windowOpen ? 1 : 0 }],
  };
}

function applyErasure(inputs: Map<string, unknown>, store: MemoryStore): { recordset: Array<Record<string, unknown>> } {
  const participantId = String(inputs.get("participant_id") ?? "");
  const hash = String(inputs.get("lookup_hash") ?? "");
  const sessionIds = new Set(
    store.sessions.filter((session) => session.participant_id === participantId).map((session) => session.id),
  );
  store.responses = store.responses.filter((response) => !sessionIds.has(response.session_id));
  for (const tile of store.artwork) {
    if (tile.session_id && sessionIds.has(tile.session_id)) {
      tile.session_id = null;
    }
  }
  store.jobs = store.jobs.filter((job) => !jobOwnedByParticipant(store, job, participantId));
  store.sessions = store.sessions.filter((session) => session.participant_id !== participantId);
  store.consents = store.consents.filter((consent) => consent.participant_id !== participantId);
  store.outbox = store.outbox.filter((row) => row.participant_id !== participantId);
  store.webhookEvents = store.webhookEvents.filter((event) => event.phone_lookup_hash !== hash);
  store.participants = store.participants.filter((participant) => participant.id !== participantId);
  const existing = store.suppression.find((item) => item.phone_lookup_hash === hash);
  if (existing) {
    existing.reason = "erasure_request";
  } else if (hash) {
    store.suppression.push({ phone_lookup_hash: hash, reason: "erasure_request", expires_at: null });
  }
  return { recordset: [] };
}

function execute(
  sqlText: string,
  inputs: Map<string, unknown>,
  store: MemoryStore,
): { recordset: Array<Record<string, unknown>> } {
  const sql = compact(sqlText);

  if (sql.includes("stop_received")) {
    return applyStop(inputs, store);
  }

  if (sql.includes("participant_erased")) {
    return applyErasure(inputs, store);
  }

  if (sql.includes("erasure_media_ids")) {
    const participantId = String(inputs.get("participant_id") ?? "");
    const mediaIds = new Set<string>();
    for (const response of store.responses) {
      const session = store.sessions.find((item) => item.id === response.session_id);
      if (session?.participant_id === participantId && response.whatsapp_media_id) {
        mediaIds.add(response.whatsapp_media_id);
      }
    }
    for (const job of store.jobs) {
      if (!jobOwnedByParticipant(store, job, participantId)) {
        continue;
      }
      const mediaId = payloadField(job.payload_json, "mediaId");
      if (mediaId) {
        mediaIds.add(mediaId);
      }
    }
    return { recordset: [...mediaIds].map((mediaId) => ({ media_id: mediaId })) };
  }

  if (sql.includes("update jobs") && sql.includes("status = 'completed'")) {
    const job = store.jobs.find((item) => item.id === inputs.get("id"));
    if (job && (!sql.includes("status = 'processing'") || job.status === "processing")) {
      job.status = "completed";
    }
    return { recordset: [] };
  }

  if (sql.includes("update jobs") && sql.includes("last_error")) {
    const job = store.jobs.find((item) => item.id === inputs.get("id"));
    if (job && (!sql.includes("status = 'processing'") || job.status === "processing")) {
      const attempts = job.attempts ?? 0;
      const maxAttempts = job.max_attempts ?? 5;
      job.status = attempts >= maxAttempts ? "failed" : "pending";
      job.last_error = String(inputs.get("error") ?? "");
    }
    return { recordset: [] };
  }

  if (sql.includes("delete from suppression_tokens")) {
    const hash = String(inputs.get("hash") ?? inputs.get("lookup_hash") ?? "");
    store.suppression = store.suppression.filter((item) => {
      if (item.phone_lookup_hash !== hash) {
        return true;
      }
      if (sql.includes("reason in ('stop', 'erasure_request')")) {
        return item.reason !== "stop" && item.reason !== "erasure_request";
      }
      if (sql.includes("reason = 'stop'")) {
        return item.reason !== "stop";
      }
      return false;
    });
    return { recordset: [] };
  }

  if (sql.includes("update participants") && sql.includes("status = 'active'")) {
    const id = String(inputs.get("participant_id") ?? inputs.get("id") ?? "");
    const row = store.participants.find((item) => item.id === id);
    if (row) {
      row.status = "active";
      row.updated_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("update outbox_messages") && sql.includes("cancelled")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row && row.status === "pending") {
      row.status = "cancelled";
    }
    return { recordset: [] };
  }

  if (sql.includes("delete from webhook_events")) {
    const hash = String(inputs.get("lookup_hash") ?? inputs.get("hash") ?? "");
    store.webhookEvents = store.webhookEvents.filter((event) => event.phone_lookup_hash !== hash);
    return { recordset: [] };
  }

  if (sql.includes("insert into compliance_records")) {
    store.compliance.push({
      phone_lookup_hash: String(inputs.get("lookup_hash") ?? inputs.get("hash") ?? ""),
      action: String(inputs.get("action") ?? "recorded"),
    });
    return { recordset: [] };
  }

  if (sql.includes("insert into webhook_events")) {
    const eventKey = String(inputs.get("event_key"));
    if (store.webhookEvents.some((event) => event.event_key === eventKey)) {
      memoryDebug.errors.push("duplicate webhook event");
      throw new Error("duplicate webhook event");
    }
    store.webhookEvents.push({
      event_key: eventKey,
      payload_hash: String(inputs.get("payload_hash")),
      phone_lookup_hash: inputs.get("phone_lookup_hash") ? String(inputs.get("phone_lookup_hash")) : null,
    });
    return { recordset: [] };
  }

  if (sql.includes("insert into participants")) {
    const hash = String(inputs.get("phone_lookup_hash"));
    if (store.participants.some((row) => row.phone_lookup_hash === hash)) {
      memoryDebug.errors.push("duplicate phone");
      throw new Error("duplicate phone");
    }
    const id = randomUUID();
    const now = new Date();
    store.participants.push({
      id,
      encrypted_phone: String(inputs.get("encrypted_phone")),
      phone_lookup_hash: hash,
      encrypted_name: String(inputs.get("encrypted_name")),
      status: "active",
      created_at: now,
      updated_at: now,
    });
    return { recordset: [{ id }] };
  }

  if (sql.includes("insert into consents")) {
    store.consents.push({
      id: randomUUID(),
      participant_id: String(inputs.get("participant_id")),
      consent_type: String(inputs.get("consent_type")),
      consent_text_version: String(inputs.get("consent_text_version")),
      granted_at: new Date(),
      withdrawn_at: null,
    });
    return { recordset: [] };
  }

  if (sql.includes("insert into interview_sessions")) {
    const id = randomUUID();
    const now = new Date();
    const awaitingKeyword = sql.includes("'awaiting_opt_in'");
    store.sessions.push({
      id,
      participant_id: String(inputs.get("participant_id")),
      state: awaitingKeyword ? "awaiting_opt_in" : "pending_invite",
      current_question_index: 0,
      service_window_expires_at: awaitingKeyword ? windowFrom(inputs) : null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
    return { recordset: [{ id }] };
  }

  if (sql.includes("insert into jobs")) {
    const participantId = inputs.get("participant_id");
    store.jobs.push({
      id: randomUUID(),
      job_type: String(inputs.get("job_type")),
      payload_json: String(inputs.get("payload_json")),
      participant_id: typeof participantId === "string" && participantId.length > 0 ? participantId : null,
      status: "pending",
    });
    return { recordset: [] };
  }

  if (sql.includes("insert into outbox_messages")) {
    store.outbox.push({
      id: randomUUID(),
      participant_id: String(inputs.get("participant_id")),
      message_type: String(inputs.get("message_type")),
      payload_json: String(inputs.get("payload_json")),
      status: "pending",
      attempts: 0,
      created_at: new Date(),
      sent_at: null,
    });
    return { recordset: [] };
  }

  if (sql.includes("from suppression_tokens")) {
    const hash = String(inputs.get("hash") ?? inputs.get("lookup_hash") ?? "");
    const row = store.suppression.find((item) => item.phone_lookup_hash === hash);
    if (!row || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
      return { recordset: [] };
    }
    if (sql.includes("select reason")) {
      return { recordset: [{ reason: row.reason }] };
    }
    return { recordset: [{ found: 1 }] };
  }

  if (sql.includes("from consents")) {
    const participantId = String(inputs.get("participant_id"));
    const rows = store.consents.filter(
      (consent) => consent.participant_id === participantId && consent.withdrawn_at === null,
    );
    return { recordset: rows.map((consent) => ({ consent_type: consent.consent_type })) };
  }

  if (sql.includes("from participants") && sql.includes("where id = @id")) {
    const row = store.participants.find((item) => item.id === inputs.get("id"));
    if (!row) {
      return { recordset: [] };
    }
    return {
      recordset: [
        {
          id: row.id,
          encrypted_phone: row.encrypted_phone,
          phone_lookup_hash: row.phone_lookup_hash,
          status: row.status,
        },
      ],
    };
  }

  if (sql.includes("from participants") && sql.includes("phone_lookup_hash")) {
    const hash = String(inputs.get("hash"));
    const row = store.participants.find((item) => item.phone_lookup_hash === hash);
    if (!row) {
      return { recordset: [] };
    }
    return {
      recordset: [
        {
          id: row.id,
          encrypted_phone: row.encrypted_phone,
          status: row.status,
        },
      ],
    };
  }

  if (sql.includes("from responses")) {
    const sessionId = String(inputs.get("session_id"));
    const rows = store.responses
      .filter((response) => response.session_id === sessionId && response.encrypted_transcript)
      .sort((a, b) => a.question_index - b.question_index);
    return { recordset: rows.map((response) => ({ ...response })) };
  }

  if (sql.includes("merge responses")) {
    const sessionId = String(inputs.get("session_id"));
    const questionIndex = Number(inputs.get("question_index"));
    const existing = store.responses.find(
      (response) => response.session_id === sessionId && response.question_index === questionIndex,
    );
    const transcript = String(inputs.get("encrypted_transcript"));
    const mediaId = inputs.get("whatsapp_media_id");
    if (existing) {
      existing.encrypted_transcript = transcript;
      if (typeof mediaId === "string") {
        existing.whatsapp_media_id = mediaId;
      }
    } else {
      store.responses.push({
        session_id: sessionId,
        question_index: questionIndex,
        encrypted_transcript: transcript,
        whatsapp_media_id: typeof mediaId === "string" ? mediaId : null,
      });
    }
    return { recordset: [] };
  }

  if (sql.includes("insert into artwork_tiles")) {
    const sessionId = String(inputs.get("session_id"));
    store.artwork.push({
      session_id: sessionId,
      color_hex: String(inputs.get("color_hex")),
      public_slug: String(inputs.get("public_slug")),
    });
    for (const response of store.responses) {
      if (response.session_id === sessionId) {
        response.encrypted_transcript = null;
      }
    }
    const session = store.sessions.find((item) => item.id === sessionId);
    const sticky = session?.state === "opted_out" || session?.state === "expired";
    if (session && !(sql.includes("not in") && sticky)) {
      session.state = "complete";
      session.completed_at = new Date();
      session.updated_at = new Date();
    }
    return { recordset: [] };
  }

  if (
    sql.includes("from interview_sessions") &&
    sql.includes("where participant_id = @participant_id") &&
    !sql.includes("not in")
  ) {
    const participantId = String(inputs.get("participant_id"));
    const rows = store.sessions.filter((session) => session.participant_id === participantId);
    return {
      recordset: rows.map((session) => ({
        id: session.id,
        state: session.state,
        participant_id: session.participant_id,
        service_window_expires_at: session.service_window_expires_at,
      })),
    };
  }

  if (sql.includes("from interview_sessions") && sql.includes("where id = @id")) {
    const row = store.sessions.find((session) => session.id === inputs.get("id"));
    if (!row) {
      return { recordset: [] };
    }
    return {
      recordset: [
        {
          id: row.id,
          state: row.state,
          participant_id: row.participant_id,
          service_window_expires_at: row.service_window_expires_at,
        },
      ],
    };
  }

  if (sql.includes("from interview_sessions") && sql.includes("not in")) {
    const participantId = String(inputs.get("participant_id"));
    const rows = store.sessions
      .filter(
        (session) =>
          session.participant_id === participantId &&
          session.state !== "complete" &&
          session.state !== "opted_out" &&
          session.state !== "expired",
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const row = rows[0];
    if (!row) {
      return { recordset: [] };
    }
    return { recordset: [{ id: row.id, state: row.state }] };
  }

  if (sql.includes("from outbox_messages")) {
    const pending = store.outbox
      .filter((row) => row.status === "pending")
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, 10)
      .map((row) => {
        const participant = store.participants.find((item) => item.id === row.participant_id);
        return {
          id: row.id,
          participant_id: row.participant_id,
          message_type: row.message_type,
          payload_json: row.payload_json,
          attempts: row.attempts,
          encrypted_phone: participant?.encrypted_phone,
        };
      });
    return { recordset: pending };
  }

  if (sql.includes("service_window_expires_at = dateadd")) {
    const row = store.sessions.find((session) => session.id === inputs.get("id"));
    const sticky = row?.state === "opted_out" || row?.state === "expired" || row?.state === "complete";
    if (row && !(sql.includes("not in") && sticky)) {
      row.service_window_expires_at = windowFrom(inputs);
      row.updated_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("state = 'awaiting_opt_in'") && sql.includes("pending_invite")) {
    for (const row of store.sessions) {
      if (row.participant_id === inputs.get("participant_id") && row.state === "pending_invite") {
        row.state = "awaiting_opt_in";
        row.updated_at = new Date();
      }
    }
    return { recordset: [] };
  }

  if (sql.includes("state = 'expired'")) {
    const row = store.sessions.find((session) => session.id === inputs.get("id"));
    if (row && row.state !== "complete" && row.state !== "opted_out" && row.state !== "expired") {
      row.state = "expired";
      row.updated_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("set state = @state")) {
    const row = store.sessions.find((session) => session.id === inputs.get("id"));
    const sticky = row?.state === "opted_out" || row?.state === "expired" || row?.state === "complete";
    if (row && !(sql.includes("not in") && sticky)) {
      row.state = String(inputs.get("state"));
      if (inputs.has("current_question_index")) {
        row.current_question_index = Number(inputs.get("current_question_index"));
      }
      row.updated_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("status = 'skipped'")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row && (!sql.includes("status = 'pending'") || row.status === "pending")) {
      row.status = "skipped";
    }
    return { recordset: [] };
  }

  if (sql.includes("status = 'sent'")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row && (!sql.includes("status = 'pending'") || row.status === "pending")) {
      row.status = "sent";
      row.sent_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("set attempts = @attempts")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row && (!sql.includes("status = 'pending'") || row.status === "pending")) {
      row.attempts = Number(inputs.get("attempts"));
      const status = inputs.get("status");
      if (typeof status === "string") {
        row.status = status;
      }
    }
    return { recordset: [] };
  }

  return fail(sqlText);
}

export class FakeTransaction {
  store: MemoryStore | null = null;
  private release: (() => void) | null = null;

  async begin(): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = transactionChain;
    transactionChain = gate;
    await previous;
    this.release = release;
    this.store = cloneStore(committed);
  }

  async commit(): Promise<void> {
    if (!this.store) {
      throw new Error("commit before begin");
    }
    committed = this.store;
    this.unlock();
  }

  async rollback(): Promise<void> {
    this.store = null;
    this.unlock();
  }

  private unlock(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }
}

export class FakeRequest {
  private readonly inputs = new Map<string, unknown>();

  constructor(private readonly tx: FakeTransaction | null) {}

  input(name: string, _type: unknown, value: unknown): this {
    this.inputs.set(name, value);
    return this;
  }

  async query(sqlText: string): Promise<{ recordset: Array<Record<string, unknown>> }> {
    const store = this.tx ? this.tx.store : committed;
    if (!store) {
      throw new Error("query before transaction begin");
    }
    return execute(sqlText, this.inputs, store);
  }
}

export async function getMemoryPool(): Promise<{ request: () => FakeRequest }> {
  return { request: () => new FakeRequest(null) };
}
