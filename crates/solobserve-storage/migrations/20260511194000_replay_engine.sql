DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'replay_run_status') THEN
    CREATE TYPE replay_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'timed_out');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS replay_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id_fk uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_signature text NOT NULL,
  modifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  share_with_team boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replay_scenarios_program_updated_idx
  ON replay_scenarios (program_id_fk, updated_at DESC);

CREATE TABLE IF NOT EXISTS replay_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id_fk uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  scenario_id_fk uuid REFERENCES replay_scenarios(id) ON DELETE SET NULL,
  signature text NOT NULL,
  modifications_hash text NOT NULL,
  status replay_run_status NOT NULL DEFAULT 'queued',
  cu_consumed bigint,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  account_diffs jsonb NOT NULL DEFAULT '[]'::jsonb,
  decoded_result jsonb,
  historical_state_unavailable boolean NOT NULL DEFAULT false,
  executed_at timestamptz,
  executed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replay_results_program_created_idx
  ON replay_results (program_id_fk, created_at DESC);

CREATE INDEX IF NOT EXISTS replay_results_scenario_idx
  ON replay_results (scenario_id_fk);
