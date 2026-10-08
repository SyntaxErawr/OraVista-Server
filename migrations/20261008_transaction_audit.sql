BEGIN;
CREATE TABLE IF NOT EXISTS audit_events (
 id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 actor_id TEXT, actor_name TEXT, actor_role TEXT, action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id TEXT, branch TEXT, changes JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS payment_events (
 id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 appointment_id INTEGER NOT NULL, patient_name TEXT, booking_ref TEXT, branch TEXT,
 service TEXT, amount NUMERIC(14,2) NOT NULL CHECK(amount > 0), method TEXT NOT NULL CHECK(method IN ('Cash','E-wallet')),
 reference TEXT, collector_id TEXT NOT NULL, collector_name TEXT
);
CREATE INDEX IF NOT EXISTS audit_events_date ON audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_events_date ON payment_events(created_at DESC, id DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION oravista_immutable_history() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'History records cannot be modified or deleted'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_audit_events ON audit_events;
CREATE TRIGGER immutable_audit_events BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION oravista_immutable_history();
DROP TRIGGER IF EXISTS immutable_payment_events ON payment_events;
CREATE TRIGGER immutable_payment_events BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_events FOR EACH STATEMENT EXECUTE FUNCTION oravista_immutable_history();
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
 INSERT INTO audit_events(actor_id, actor_name, actor_role, action, entity, entity_id, branch, changes)
 VALUES(actor->>'id', COALESCE(NULLIF(actor->>'name',''),'System / unidentified'), actor->>'role', TG_OP || ' ' || COALESCE(current_setting('oravista.action', true),''), TG_TABLE_NAME, COALESCE(current_record->>'id',previous->>'id'), COALESCE(current_record->>'branch',previous->>'branch'), details);
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE target TEXT;
BEGIN
 FOREACH target IN ARRAY ARRAY['users','appointments','patient_records','ai_diagnostics'] LOOP
  IF to_regclass(target) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS oravista_audit_write ON %I', target);
   EXECUTE format('CREATE TRIGGER oravista_audit_write AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION oravista_capture_audit()', target);
  END IF;
 END LOOP;
END $$;
COMMIT;
