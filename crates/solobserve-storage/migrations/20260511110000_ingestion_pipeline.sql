CREATE TYPE commitment_promotion AS ENUM ('confirmed', 'finalized');

CREATE TABLE ingestion_configs (
    program_id_fk UUID PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    primary_endpoint TEXT NOT NULL,
    fallback_endpoints TEXT[] NOT NULL DEFAULT '{}',
    commitment_promotion commitment_promotion NOT NULL DEFAULT 'confirmed',
    backfill_window_hours INT NOT NULL DEFAULT 24,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paused_at TIMESTAMPTZ
);

CREATE TABLE ingestion_state (
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    last_processed_slot BIGINT NOT NULL DEFAULT 0,
    last_processed_signature TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lag_slots INT NOT NULL DEFAULT 0,
    PRIMARY KEY (program_id_fk, cluster)
);

CREATE TABLE ingestion_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    signature TEXT,
    slot BIGINT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX ingestion_errors_program_idx ON ingestion_errors(program_id_fk, occurred_at DESC);

CREATE TABLE tracked_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    account TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (program_id_fk, cluster, account)
);
