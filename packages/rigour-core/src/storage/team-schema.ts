/**
 * PostgreSQL team schema. Idempotent: re-running it on an existing database
 * (`rigour team init-schema`) adds anything missing, including the RLS
 * policies, without touching data.
 */
export const TEAM_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS rigour;
CREATE TABLE IF NOT EXISTS rigour.meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rigour.memberships (
    db_role NAME NOT NULL,
    organization_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'sme', 'owner')),
    PRIMARY KEY (db_role, team_id)
);
CREATE TABLE IF NOT EXISTS rigour.lessons (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('personal', 'team')),
    state TEXT NOT NULL CHECK (state IN ('candidate', 'validated', 'promoted', 'rejected', 'superseded')),
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    evidence_json JSONB NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    source TEXT NOT NULL,
    supersedes_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
-- Every sync reads a team's lessons changed since its last read.
CREATE INDEX IF NOT EXISTS lessons_team_updated ON rigour.lessons (organization_id, team_id, updated_at);
ALTER TABLE rigour.lessons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lessons_read ON rigour.lessons;
CREATE POLICY lessons_read ON rigour.lessons FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lessons.organization_id
          AND membership.team_id = lessons.team_id
          AND ((lessons.visibility = 'team' AND lessons.state = 'promoted')
               OR membership.actor_id = lessons.actor_id)
    )
);
DROP POLICY IF EXISTS lessons_write ON rigour.lessons;
CREATE POLICY lessons_write ON rigour.lessons FOR ALL USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lessons.organization_id
          AND membership.team_id = lessons.team_id
          AND membership.actor_id = lessons.actor_id
          AND (lessons.visibility = 'personal' OR membership.role IN ('sme', 'owner'))
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lessons.organization_id
          AND membership.team_id = lessons.team_id
          AND membership.actor_id = lessons.actor_id
          AND (lessons.visibility = 'personal' OR membership.role IN ('sme', 'owner'))
    )
);
-- Row-level security on every team table. A host (for example Supabase's
-- security advisor) may enable RLS on its own; without a policy each member
-- login would then see no rows at all. Members read only their own
-- membership rows (the lessons policies read memberships the same way), and
-- meta holds only the schema version.
ALTER TABLE rigour.memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_read_own ON rigour.memberships;
CREATE POLICY memberships_read_own ON rigour.memberships FOR SELECT USING (db_role = current_user);
ALTER TABLE rigour.meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_read ON rigour.meta;
CREATE POLICY meta_read ON rigour.meta FOR SELECT USING (true);
-- Review decisions (review_decisions_version 1): people's decisions on review lessons, shared so every teammate's brief
-- is the same. Needs PostgreSQL 13 or later (gen_random_uuid). schema_version stays 1, so older clients keep working.
--
-- The name a teammate's brief shows for whoever decided, set by the administrator; never a login or an email.
ALTER TABLE rigour.memberships ADD COLUMN IF NOT EXISTS display_name TEXT;
-- A random salt per organization for hashing reviewer logins, so a hash from one organization never matches another's.
CREATE TABLE IF NOT EXISTS rigour.organization_salts (
    organization_id TEXT PRIMARY KEY,
    salt TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
CREATE OR REPLACE FUNCTION rigour.add_organization_salt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO rigour.organization_salts (organization_id) VALUES (NEW.organization_id) ON CONFLICT DO NOTHING;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS memberships_organization_salt ON rigour.memberships;
CREATE TRIGGER memberships_organization_salt AFTER INSERT OR UPDATE OF organization_id ON rigour.memberships
    FOR EACH ROW EXECUTE FUNCTION rigour.add_organization_salt();
INSERT INTO rigour.organization_salts (organization_id) SELECT DISTINCT organization_id FROM rigour.memberships
ON CONFLICT DO NOTHING;
ALTER TABLE rigour.organization_salts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_salts_read ON rigour.organization_salts;
CREATE POLICY organization_salts_read ON rigour.organization_salts FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = organization_salts.organization_id
    )
);
-- One row per decision, never updated or deleted: a decision taken back is a new row. Carries no review text: the
-- lesson's approved wording only (payload.text, at most 400 characters), hashed file and reviewer, and the reason.
CREATE TABLE IF NOT EXISTS rigour.review_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('accepted', 'rejected', 'dismissed', 'scoped', 'reworded', 'correction', 'compiled')),
    actor_id TEXT NOT NULL,
    actor_name TEXT,
    client_key TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (length(coalesce(payload->>'text', '')) <= 400),
    UNIQUE (organization_id, team_id, client_key)
);
-- The server sets when a decision arrived and who made it, by name: the client sends neither.
CREATE OR REPLACE FUNCTION rigour.stamp_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.received_at := clock_timestamp();
    NEW.actor_name := (
        SELECT membership.display_name FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = NEW.organization_id
          AND membership.team_id = NEW.team_id
          AND membership.actor_id = NEW.actor_id
    );
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_decisions_stamp ON rigour.review_decisions;
CREATE TRIGGER review_decisions_stamp BEFORE INSERT ON rigour.review_decisions
    FOR EACH ROW EXECUTE FUNCTION rigour.stamp_review_decision();
-- Every sync reads one repository's decisions that arrived since its last read.
CREATE INDEX IF NOT EXISTS review_decisions_repository_received
    ON rigour.review_decisions (organization_id, team_id, repository_id, received_at);
ALTER TABLE rigour.review_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_decisions_read ON rigour.review_decisions;
CREATE POLICY review_decisions_read ON rigour.review_decisions FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = review_decisions.organization_id
          AND membership.team_id = review_decisions.team_id
    )
);
-- Only an sme or owner shares a decision, under their own actor. There is no update or delete policy.
DROP POLICY IF EXISTS review_decisions_insert ON rigour.review_decisions;
CREATE POLICY review_decisions_insert ON rigour.review_decisions FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = review_decisions.organization_id
          AND membership.team_id = review_decisions.team_id
          AND membership.actor_id = review_decisions.actor_id
          AND membership.role IN ('sme', 'owner')
    )
);
INSERT INTO rigour.meta (key, value) VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
INSERT INTO rigour.meta (key, value) VALUES ('review_decisions_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;
