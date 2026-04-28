CREATE TABLE decode_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    slot BIGINT,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX decode_errors_program_created_idx ON decode_errors(program_id_fk, created_at DESC);

CREATE TABLE account_state (
    account TEXT PRIMARY KEY,
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    account_type TEXT,
    decoded_json JSONB NOT NULL,
    slot BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE account_state_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account TEXT NOT NULL,
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    cluster solana_cluster NOT NULL,
    slot BIGINT NOT NULL,
    account_type TEXT,
    decoded_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account, slot)
);

CREATE INDEX account_state_history_program_slot_idx
ON account_state_history(program_id_fk, slot DESC);
