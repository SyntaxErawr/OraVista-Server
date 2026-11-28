BEGIN;
-- users also identifies the retained clinical chart. This marker is irreversible
-- through account/profile endpoints; it is not a recoverable disabled login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS account_deletion_cleanup (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
 bucket TEXT NOT NULL CHECK (bucket = 'profile-photo'), object_path TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(bucket, object_path)
);
ALTER TABLE account_deletion_cleanup ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS account_deletion_cleanup_due ON account_deletion_cleanup(next_attempt_at);
CREATE OR REPLACE FUNCTION oravista_capture_audit() RETURNS trigger AS $$
DECLARE previous JSONB := '{}'; current_record JSONB := '{}'; actor JSONB; details JSONB;
BEGIN
 IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN current_record := to_jsonb(NEW); END IF;
 actor := COALESCE(NULLIF(current_setting('oravista.actor', true), ''), '{}')::jsonb;
 SELECT COALESCE(jsonb_object_agg(key, jsonb_build_object('before', previous->key, 'after', current_record->key)), '{}') INTO details
 FROM (SELECT jsonb_object_keys(previous || current_record) AS key) fields
 WHERE key IN ('first_name','last_name','email','phone','role','status','branch','appointment_date','appointment_time','dentist_name','service_type','amount','billing_status','receipt_details','file_name')
 AND previous->key IS DISTINCT FROM current_record->key;
 -- Store financial receipt fields only, never arbitrary nested clinical or credential payloads.
 IF details ? 'receipt_details' THEN details := (details - 'receipt_details') || jsonb_build_object('receipt_details', 'Receipt updated'); END IF;
 IF previous ? 'password' AND previous->'password' IS DISTINCT FROM current_record->'password' THEN details := details || jsonb_build_object('password', 'Credential changed (value excluded)'); END IF;
 -- Do not copy erased sign-in/contact details into a new audit event.
 IF TG_TABLE_NAME = 'users' AND current_record->>'account_deleted_at' IS NOT NULL
    AND previous->>'account_deleted_at' IS NULL THEN
   details := jsonb_build_object('account', 'App credentials deleted; clinic chart retained');
 END IF;
 INSERT INTO audit_events(actor_id, actor_name, actor_role, action, entity, entity_id, branch, changes)
 VALUES(actor->>'id', COALESCE(NULLIF(actor->>'name',''),'System / unidentified'), actor->>'role', TG_OP || ' ' || COALESCE(current_setting('oravista.action', true),''), TG_TABLE_NAME, COALESCE(current_record->>'id',previous->>'id'), COALESCE(current_record->>'branch',previous->>'branch'), details);
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
