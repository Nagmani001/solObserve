DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_rule_kind') THEN
        CREATE TYPE alert_rule_kind AS ENUM ('dsl', 'template');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_severity') THEN
        CREATE TYPE alert_severity AS ENUM ('info', 'warn', 'critical');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_state_status') THEN
        CREATE TYPE alert_state_status AS ENUM ('ok', 'pending', 'firing', 'stale');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_incident_status') THEN
        CREATE TYPE alert_incident_status AS ENUM ('firing', 'acknowledged', 'resolved', 'silenced');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_incident_event_kind') THEN
        CREATE TYPE alert_incident_event_kind AS ENUM ('fired', 'notified', 'acked', 'resolved', 'comment', 'related_tx', 'related_state');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel_kind') THEN
        CREATE TYPE notification_channel_kind AS ENUM ('slack', 'discord', 'email', 'webhook', 'pagerduty', 'telegram');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind alert_rule_kind NOT NULL,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    evaluation_interval_seconds INT NOT NULL DEFAULT 30,
    severity alert_severity NOT NULL DEFAULT 'warn',
    group_by TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rule_state (
    rule_id UUID PRIMARY KEY REFERENCES alert_rules(id) ON DELETE CASCADE,
    last_eval_at TIMESTAMPTZ,
    last_value JSONB,
    last_status alert_state_status NOT NULL DEFAULT 'ok',
    since_ts TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id_fk UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    status alert_incident_status NOT NULL DEFAULT 'firing',
    severity alert_severity NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acked_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    ack_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    UNIQUE(rule_id_fk, dedup_key)
);

CREATE TABLE IF NOT EXISTS alert_incident_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id_fk UUID NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
    kind alert_incident_event_kind NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_silences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    matcher JSONB NOT NULL DEFAULT '{}'::jsonb,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id_fk UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind notification_channel_kind NOT NULL,
    name TEXT NOT NULL,
    config_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id_fk UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    matchers JSONB NOT NULL DEFAULT '{}'::jsonb,
    channel_ids UUID[] NOT NULL DEFAULT '{}',
    severity_min alert_severity NOT NULL DEFAULT 'warn',
    group_wait_seconds INT NOT NULL DEFAULT 30,
    group_interval_seconds INT NOT NULL DEFAULT 300,
    repeat_interval_seconds INT NOT NULL DEFAULT 14400
);

CREATE TABLE IF NOT EXISTS oncall_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id_fk UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC'
);

CREATE TABLE IF NOT EXISTS oncall_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id_fk UUID NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    override BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS escalation_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id_fk UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb
);
