-- Plan 13: web3 intelligence layer

ALTER TABLE programs
    ADD COLUMN IF NOT EXISTS mev_detection_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE dashboards
    ADD COLUMN IF NOT EXISTS share_password_hash TEXT,
    ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS share_referer_allowlist TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS share_view_count INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
    CREATE TYPE "TagScope" AS ENUM ('public_','org');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS addresses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address       TEXT UNIQUE NOT NULL,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ,
    sol_balance   BIGINT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS tags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    scope       "TagScope" NOT NULL,
    org_id_fk   UUID REFERENCES orgs(id) ON DELETE CASCADE,
    color       TEXT NOT NULL DEFAULT '#888',
    description TEXT,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_scope_org_name_uniq
    ON tags(scope, COALESCE(org_id_fk, '00000000-0000-0000-0000-000000000000'::uuid), name);

CREATE TABLE IF NOT EXISTS address_tags (
    address_id_fk UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    tag_id_fk     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    applied_by    UUID,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (address_id_fk, tag_id_fk)
);

CREATE TABLE IF NOT EXISTS tag_proposals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address     TEXT NOT NULL,
    tag_id_fk   UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_by  UUID,
    reviewed_by UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tag_proposals_status_idx ON tag_proposals(status);

CREATE TABLE IF NOT EXISTS watchlists (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    address_set   TEXT[] NOT NULL DEFAULT '{}',
    tag_set       UUID[] NOT NULL DEFAULT '{}',
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watchlists_program_idx ON watchlists(program_id_fk);

CREATE TABLE IF NOT EXISTS mev_findings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk       UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL,
    slot                BIGINT NOT NULL,
    signature           TEXT NOT NULL,
    related_signatures  TEXT[] NOT NULL DEFAULT '{}',
    confidence          DOUBLE PRECISION NOT NULL,
    evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mev_findings_program_idx
    ON mev_findings(program_id_fk, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS anomalies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    metric        TEXT NOT NULL,
    bucket        TIMESTAMPTZ NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    baseline      DOUBLE PRECISION NOT NULL,
    z_score       DOUBLE PRECISION NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'info',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anomalies_program_metric_idx
    ON anomalies(program_id_fk, metric, bucket DESC);

CREATE TABLE IF NOT EXISTS rpc_endpoints (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster             TEXT NOT NULL,
    endpoint_url        TEXT NOT NULL,
    endpoint_hash       TEXT NOT NULL UNIQUE,
    permanently_demoted BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster, endpoint_url)
);
