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
};

export type MemoryTile = {
  session_id: string;
  color_hex: string;
  public_slug: string;
};

export type MemoryStore = {
  participants: MemoryParticipant[];
  consents: MemoryConsent[];
  sessions: MemorySession[];
  outbox: MemoryOutbox[];
  responses: MemoryResponse[];
  artwork: MemoryTile[];
  jobs: Array<{ job_type: string; payload_json: string }>;
  webhookEvents: Array<{ event_key: string; payload_hash: string }>;
  suppression: Array<{ phone_lookup_hash: string; expires_at: Date | null }>;
};

export const memoryDebug = {
  errors: [] as string[],
};

let committed: MemoryStore = emptyStore();

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
  };
}

function cloneStore(store: MemoryStore): MemoryStore {
  return structuredClone(store);
}

export function resetMemory(): void {
  committed = emptyStore();
  memoryDebug.errors = [];
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

function execute(
  sqlText: string,
  inputs: Map<string, unknown>,
  store: MemoryStore,
): { recordset: Array<Record<string, unknown>> } {
  const sql = compact(sqlText);

  if (sql.includes("insert into webhook_events")) {
    const eventKey = String(inputs.get("event_key"));
    if (store.webhookEvents.some((event) => event.event_key === eventKey)) {
      memoryDebug.errors.push("duplicate webhook event");
      throw new Error("duplicate webhook event");
    }
    store.webhookEvents.push({
      event_key: eventKey,
      payload_hash: String(inputs.get("payload_hash")),
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
    store.jobs.push({
      job_type: String(inputs.get("job_type")),
      payload_json: String(inputs.get("payload_json")),
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
    const hash = String(inputs.get("hash"));
    const row = store.suppression.find((item) => item.phone_lookup_hash === hash);
    if (!row || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
      return { recordset: [] };
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
    if (existing) {
      existing.encrypted_transcript = transcript;
    } else {
      store.responses.push({
        session_id: sessionId,
        question_index: questionIndex,
        encrypted_transcript: transcript,
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
    if (session) {
      session.state = "complete";
      session.completed_at = new Date();
      session.updated_at = new Date();
    }
    return { recordset: [] };
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
    if (row) {
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
    if (row) {
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
    if (row) {
      row.status = "skipped";
    }
    return { recordset: [] };
  }

  if (sql.includes("status = 'sent'")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row) {
      row.status = "sent";
      row.sent_at = new Date();
    }
    return { recordset: [] };
  }

  if (sql.includes("set attempts = @attempts")) {
    const row = store.outbox.find((item) => item.id === inputs.get("id"));
    if (row) {
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

  async begin(): Promise<void> {
    this.store = cloneStore(committed);
  }

  async commit(): Promise<void> {
    if (!this.store) {
      throw new Error("commit before begin");
    }
    committed = this.store;
  }

  async rollback(): Promise<void> {
    this.store = null;
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
