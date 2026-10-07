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
INSERT INTO rigour.meta (key, value) VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;
