-- Legacy jobs written before participant_id existed can still be tied to a person
-- through the session id (or participant id) stored in the payload. Link them, then
-- drop phone-bearing keys. sessionId stays so a later STOP or erasure can still
-- find the row if the backfill could not.
UPDATE j
SET j.participant_id = s.participant_id
FROM jobs AS j
INNER JOIN interview_sessions AS s
  ON s.id = TRY_CONVERT(uniqueidentifier, JSON_VALUE(j.payload_json, '$.sessionId'))
WHERE j.participant_id IS NULL
  AND ISJSON(j.payload_json) = 1;
GO

UPDATE jobs
SET participant_id = TRY_CONVERT(uniqueidentifier, JSON_VALUE(payload_json, '$.participantId'))
WHERE participant_id IS NULL
  AND ISJSON(payload_json) = 1
  AND TRY_CONVERT(uniqueidentifier, JSON_VALUE(payload_json, '$.participantId')) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM participants AS p
    WHERE p.id = TRY_CONVERT(uniqueidentifier, JSON_VALUE(jobs.payload_json, '$.participantId'))
  );
GO

-- JSON_MODIFY with NULL removes the key. These are the phone-bearing names the app refuses.
UPDATE jobs
SET payload_json = JSON_MODIFY(
  JSON_MODIFY(
    JSON_MODIFY(
      JSON_MODIFY(payload_json, '$.phone', NULL),
      '$.to', NULL
    ),
    '$.from', NULL
  ),
  '$.msisdn', NULL
)
WHERE ISJSON(payload_json) = 1;
GO

-- last_error is free text and may contain a provider body with a phone number.
-- SQL Server has no safe redaction for that, so any value that contains a digit is cleared.
UPDATE jobs
SET last_error = NULL
WHERE last_error LIKE '%[0-9]%';
GO

-- webhook_events stored only event_key (a WhatsApp message id) and a sha256 of the
-- body. phone_lookup_hash cannot be derived for rows written before that column
-- existed. Rows newer than 7 days are kept so a delayed provider retry stays
-- idempotent (longer than the 24-hour customer-care window). Older rows with no
-- lookup hash are deleted: erasure cannot target them, and they should not live forever.
DELETE FROM webhook_events
WHERE phone_lookup_hash IS NULL
  AND processed_at < DATEADD(day, -7, SYSUTCDATETIME());
GO
