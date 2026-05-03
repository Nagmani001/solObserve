DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'error_issue_status') THEN
        CREATE TYPE error_issue_status AS ENUM ('open', 'acknowledged', 'resolved', 'muted');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'error_classification') THEN
        CREATE TYPE error_classification AS ENUM ('anchor_constraint', 'anchor_custom', 'runtime', 'unknown');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS error_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    instruction_name TEXT,
    error_code INT,
    error_name TEXT,
    classification error_classification NOT NULL DEFAULT 'unknown',
    top_constraint_kind TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_count BIGINT NOT NULL DEFAULT 0,
    status error_issue_status NOT NULL DEFAULT 'open',
    muted_until TIMESTAMPTZ,
    assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(program_id_fk, fingerprint)
);

CREATE TABLE IF NOT EXISTS error_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id_fk UUID NOT NULL REFERENCES error_issues(id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL,
    block_time TIMESTAMPTZ,
    signer TEXT,
    decoded_args JSONB NOT NULL DEFAULT '{}'::jsonb,
    decoded_accounts JSONB NOT NULL DEFAULT '{}'::jsonb,
    log_lines TEXT[] NOT NULL DEFAULT '{}',
    constraint_kind TEXT,
    constraint_expected TEXT,
    constraint_got TEXT,
    cu_consumed BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_samples_issue_created_idx
ON error_samples(issue_id_fk, created_at DESC);

CREATE TABLE IF NOT EXISTS error_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id_fk UUID NOT NULL REFERENCES error_issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_field_watches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    account TEXT NOT NULL,
    field_path TEXT NOT NULL,
    op TEXT NOT NULL DEFAULT 'changed',
    threshold_numeric DOUBLE PRECISION,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS error_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    issue_id_fk UUID REFERENCES error_issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION set_error_issue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS error_issues_set_updated_at ON error_issues;
CREATE TRIGGER error_issues_set_updated_at
BEFORE UPDATE ON error_issues
FOR EACH ROW
EXECUTE FUNCTION set_error_issue_updated_at();
