-- Plan 11: SDK schema registration (§11.4)

CREATE TABLE IF NOT EXISTS sdk_schemas (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk   UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    schema_json     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (program_id_fk, name, version)
);

CREATE INDEX IF NOT EXISTS sdk_schemas_program_idx ON sdk_schemas (program_id_fk);
