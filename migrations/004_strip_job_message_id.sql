-- Voice-note jobs used to store the WhatsApp message id next to the media id.
-- messageId is not needed to process the note, and it can be joined back to a
-- webhook delivery. Remove it. JSON_MODIFY with NULL drops the key. Safe to re-run.
UPDATE jobs
SET payload_json = JSON_MODIFY(JSON_MODIFY(payload_json, '$.messageId', NULL), '$.message_id', NULL)
WHERE ISJSON(payload_json) = 1
  AND (
    JSON_VALUE(payload_json, '$.messageId') IS NOT NULL
    OR JSON_VALUE(payload_json, '$.message_id') IS NOT NULL
  );
GO
