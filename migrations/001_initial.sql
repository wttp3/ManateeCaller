IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'schema_migrations')
BEGIN
  CREATE TABLE schema_migrations (
    version NVARCHAR(64) NOT NULL PRIMARY KEY,
    applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'participants')
BEGIN
  CREATE TABLE participants (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    encrypted_phone NVARCHAR(512) NOT NULL,
    phone_lookup_hash CHAR(64) NOT NULL,
    encrypted_name NVARCHAR(512) NOT NULL,
    status NVARCHAR(32) NOT NULL DEFAULT 'active',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_participants_phone_lookup UNIQUE (phone_lookup_hash)
  );
  CREATE INDEX IX_participants_status ON participants(status);
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'consents')
BEGIN
  CREATE TABLE consents (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    participant_id UNIQUEIDENTIFIER NOT NULL,
    consent_type NVARCHAR(64) NOT NULL,
    consent_text_version NVARCHAR(32) NOT NULL,
    granted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    withdrawn_at DATETIME2 NULL,
    CONSTRAINT FK_consents_participant FOREIGN KEY (participant_id) REFERENCES participants(id)
  );
  CREATE INDEX IX_consents_participant ON consents(participant_id);
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'interview_sessions')
BEGIN
  CREATE TABLE interview_sessions (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    participant_id UNIQUEIDENTIFIER NOT NULL,
    state NVARCHAR(64) NOT NULL DEFAULT 'pending_invite',
    current_question_index INT NOT NULL DEFAULT 0,
    service_window_expires_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at DATETIME2 NULL,
    CONSTRAINT FK_sessions_participant FOREIGN KEY (participant_id) REFERENCES participants(id)
  );
  CREATE INDEX IX_sessions_participant ON interview_sessions(participant_id);
  CREATE INDEX IX_sessions_state ON interview_sessions(state);
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'responses')
BEGIN
  CREATE TABLE responses (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    session_id UNIQUEIDENTIFIER NOT NULL,
    question_index INT NOT NULL,
    encrypted_transcript NVARCHAR(MAX) NULL,
    whatsapp_media_id NVARCHAR(128) NULL,
    processed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_responses_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id),
    CONSTRAINT UQ_responses_session_question UNIQUE (session_id, question_index)
  );
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'artwork_tiles')
BEGIN
  CREATE TABLE artwork_tiles (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    session_id UNIQUEIDENTIFIER NULL,
    color_hex CHAR(7) NOT NULL,
    public_slug CHAR(12) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_artwork_slug UNIQUE (public_slug)
  );
  CREATE INDEX IX_artwork_created ON artwork_tiles(created_at DESC);
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'webhook_events')
BEGIN
  CREATE TABLE webhook_events (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    event_key NVARCHAR(256) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    processed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_webhook_event_key UNIQUE (event_key)
  );
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'jobs')
BEGIN
  CREATE TABLE jobs (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    job_type NVARCHAR(64) NOT NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    status NVARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    run_after DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    locked_until DATETIME2 NULL,
    locked_by NVARCHAR(64) NULL,
    last_error NVARCHAR(512) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_jobs_pending ON jobs(status, run_after) WHERE status = 'pending';
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'outbox_messages')
BEGIN
  CREATE TABLE outbox_messages (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    participant_id UNIQUEIDENTIFIER NOT NULL,
    message_type NVARCHAR(64) NOT NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    status NVARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    sent_at DATETIME2 NULL,
    CONSTRAINT FK_outbox_participant FOREIGN KEY (participant_id) REFERENCES participants(id)
  );
  CREATE INDEX IX_outbox_pending ON outbox_messages(status, created_at) WHERE status = 'pending';
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'suppression_tokens')
BEGIN
  CREATE TABLE suppression_tokens (
    phone_lookup_hash CHAR(64) NOT NULL PRIMARY KEY,
    reason NVARCHAR(64) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    expires_at DATETIME2 NULL
  );
END;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'compliance_records')
BEGIN
  CREATE TABLE compliance_records (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    phone_lookup_hash CHAR(64) NOT NULL,
    action NVARCHAR(64) NOT NULL,
    metadata_json NVARCHAR(512) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_compliance_lookup ON compliance_records(phone_lookup_hash);
END;
GO
