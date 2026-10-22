-- Job rows point at a participant. Payloads must not carry a phone number.
IF COL_LENGTH('jobs', 'participant_id') IS NULL
BEGIN
  ALTER TABLE jobs ADD participant_id UNIQUEIDENTIFIER NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_jobs_participant' AND object_id = OBJECT_ID('jobs'))
BEGIN
  CREATE INDEX IX_jobs_participant ON jobs(participant_id, status);
END;
GO

-- Lets erasure remove the sender's webhook rows without storing the phone.
IF COL_LENGTH('webhook_events', 'phone_lookup_hash') IS NULL
BEGIN
  ALTER TABLE webhook_events ADD phone_lookup_hash CHAR(64) NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_webhook_lookup' AND object_id = OBJECT_ID('webhook_events'))
BEGIN
  CREATE INDEX IX_webhook_lookup ON webhook_events(phone_lookup_hash);
END;
GO
