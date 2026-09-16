-- Patient notification support for the PostgreSQL/Supabase database.
CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
    notification_type VARCHAR(80) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_appointment_type
    ON notifications (user_id, appointment_id, notification_type)
    WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_user_created_at_idx
    ON notifications (user_id, created_at DESC);

ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS reminder_email_sent_at TIMESTAMPTZ;
