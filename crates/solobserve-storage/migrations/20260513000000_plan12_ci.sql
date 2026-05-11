-- Plan 12: CU regression CI

ALTER TABLE programs
    ADD COLUMN IF NOT EXISTS cu_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS gh_installations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id_fk       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    installation_id BIGINT NOT NULL UNIQUE,
    account_login   TEXT NOT NULL,
    account_type    TEXT NOT NULL,
    repo_ids        BIGINT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gh_installations_org_idx ON gh_installations(org_id_fk);

CREATE TABLE IF NOT EXISTS gh_repos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id_fk  UUID NOT NULL REFERENCES gh_installations(id) ON DELETE CASCADE,
    repo_full_name      TEXT NOT NULL,
    default_branch      TEXT NOT NULL DEFAULT 'main',
    linked_program_ids  UUID[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (installation_id_fk, repo_full_name)
);

DO $$ BEGIN
    CREATE TYPE "CuRunStatus" AS ENUM ('pending','success','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cu_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk    UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    repo_id_fk       UUID REFERENCES gh_repos(id) ON DELETE SET NULL,
    commit_sha       TEXT NOT NULL,
    branch           TEXT NOT NULL,
    pr_number        INTEGER,
    status           "CuRunStatus" NOT NULL DEFAULT 'pending',
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,
    raw_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
    bypass_applied   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS cu_runs_program_commit_idx ON cu_runs(program_id_fk, commit_sha);
CREATE INDEX IF NOT EXISTS cu_runs_program_branch_idx ON cu_runs(program_id_fk, branch);

CREATE TABLE IF NOT EXISTS cu_baselines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk     UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    repo_id_fk        UUID REFERENCES gh_repos(id) ON DELETE SET NULL,
    branch            TEXT NOT NULL,
    commit_sha        TEXT NOT NULL,
    instruction_name  TEXT NOT NULL,
    cu_p50            INTEGER NOT NULL,
    cu_p95            INTEGER NOT NULL,
    run_id            UUID REFERENCES cu_runs(id) ON DELETE SET NULL,
    captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (program_id_fk, branch, commit_sha, instruction_name)
);
CREATE INDEX IF NOT EXISTS cu_baselines_program_branch_idx ON cu_baselines(program_id_fk, branch);
