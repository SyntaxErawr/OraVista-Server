ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS receipt_details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) NOT NULL DEFAULT 'Pending';

UPDATE appointments
SET billing_status = 'Pending'
WHERE billing_status IS NULL;
