DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dashboard_template_kind') THEN
        CREATE TYPE dashboard_template_kind AS ENUM (
            'generic_anchor',
            'dex',
            'lending',
            'nft',
            'escrow',
            'governance',
            'staking'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS dashboards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id_fk UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_template_seeded BOOLEAN NOT NULL DEFAULT false,
    share_token TEXT UNIQUE,
    share_redact_signers BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(program_id_fk, slug)
);

CREATE TABLE IF NOT EXISTS dashboard_panels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id_fk UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    position JSONB NOT NULL DEFAULT '{"x":0,"y":0,"w":6,"h":4}'::jsonb,
    title TEXT NOT NULL,
    panel_type TEXT NOT NULL,
    query_dsl TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    kind dashboard_template_kind NOT NULL,
    definition JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_dashboard_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dashboards_set_updated_at ON dashboards;
CREATE TRIGGER dashboards_set_updated_at
BEFORE UPDATE ON dashboards
FOR EACH ROW
EXECUTE FUNCTION set_dashboard_updated_at();

DROP TRIGGER IF EXISTS dashboard_panels_set_updated_at ON dashboard_panels;
CREATE TRIGGER dashboard_panels_set_updated_at
BEFORE UPDATE ON dashboard_panels
FOR EACH ROW
EXECUTE FUNCTION set_dashboard_updated_at();

DROP TRIGGER IF EXISTS dashboard_templates_set_updated_at ON dashboard_templates;
CREATE TRIGGER dashboard_templates_set_updated_at
BEFORE UPDATE ON dashboard_templates
FOR EACH ROW
EXECUTE FUNCTION set_dashboard_updated_at();
