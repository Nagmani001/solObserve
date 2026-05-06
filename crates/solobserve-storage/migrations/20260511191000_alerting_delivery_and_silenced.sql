DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'alert_incident_event_kind' AND e.enumlabel = 'silenced'
    ) THEN
        ALTER TYPE alert_incident_event_kind ADD VALUE 'silenced';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_delivery_status') THEN
        CREATE TYPE alert_delivery_status AS ENUM ('pending', 'sent', 'failed');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS alert_notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id_fk UUID NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    route_id_fk UUID REFERENCES notification_routes(id) ON DELETE SET NULL,
    channel_id_fk UUID REFERENCES notification_channels(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status alert_delivery_status NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_delivery_due_idx
ON alert_notification_deliveries(status, next_attempt_at);
