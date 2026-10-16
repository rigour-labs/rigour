/**
 * Who may read and write team lessons (rigour.lessons), in the database. Part of TEAM_SCHEMA; idempotent.
 *
 * - Read: the team's promoted lessons, your own, and, for an sme or owner, every team lesson of the team.
 * - Insert: your own lessons (team ones as an sme or owner, or as a candidate for anyone), and, as an sme or owner,
 *   a team lesson under a member of the same team (a teammate's candidate shared).
 * - Update: as insert, checked on the old row and the new; a member may also drop (reject) their own candidate.
 * - Delete: only your own personal lessons.
 * - A trigger keeps a lesson's id, text, author and repository as written, lets only its author change its evidence,
 *   and stamps who changed its state (decided_by) from the writer's membership: never from the client.
 *
 * The policies carry a version in their names (lessons_*_v2), so a client can tell from pg_policies that these rules
 * are in force, and that no older init-schema has put its own back beside them (lessons_read, lessons_write).
 */
const member = (condition: string) => `EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lessons.organization_id
          AND membership.team_id = lessons.team_id
          AND (${condition})
    )`;

const OWN = 'membership.actor_id = lessons.actor_id';
const DECIDER = "membership.role IN ('sme', 'owner')";
const TEAM = "lessons.visibility = 'team'";
/** Your own lesson: personal, or any team one as an sme or owner. */
const YOURS = `(${OWN} AND (lessons.visibility = 'personal' OR ${DECIDER}))`;
/** Any team lesson of the team, as an sme or owner. */
const DECIDES = `(${TEAM} AND ${DECIDER})`;
/** A team candidate of your own, whatever your role, or one you replaced with a correction. */
const PROPOSES = `(${OWN} AND ${TEAM} AND lessons.state IN ('candidate', 'superseded'))`;

/** The policy names this version creates; a client checks pg_policies for them. */
export const LESSON_POLICIES = ['lessons_read_v2', 'lessons_insert_v2', 'lessons_update_v2', 'lessons_delete_v2'];
/** The policy names of earlier versions, dropped here; an older init-schema puts them back. */
export const LEGACY_LESSON_POLICIES = ['lessons_read', 'lessons_write'];

export const LESSON_RULES = `
ALTER TABLE rigour.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE rigour.lessons ADD COLUMN IF NOT EXISTS decided_by TEXT;
DROP POLICY IF EXISTS lessons_read ON rigour.lessons;
DROP POLICY IF EXISTS lessons_write ON rigour.lessons;
-- Whether an actor is a member of the team: memberships are readable only row by row (memberships_read_own), so this
-- answers as the schema owner, and only to a login that is itself a member of that organization and team.
CREATE OR REPLACE FUNCTION rigour.team_actor(organization TEXT, team TEXT, actor TEXT) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM rigour.memberships caller WHERE caller.db_role = session_user
                     AND caller.organization_id = organization AND caller.team_id = team)
       AND EXISTS (SELECT 1 FROM rigour.memberships author WHERE author.organization_id = organization
                     AND author.team_id = team AND author.actor_id = actor)
$$;
DROP POLICY IF EXISTS lessons_read_v2 ON rigour.lessons;
CREATE POLICY lessons_read_v2 ON rigour.lessons FOR SELECT USING (
    ${member(`(${TEAM} AND lessons.state = 'promoted') OR ${OWN} OR ${DECIDES}`)}
);
DROP POLICY IF EXISTS lessons_insert_v2 ON rigour.lessons;
CREATE POLICY lessons_insert_v2 ON rigour.lessons FOR INSERT WITH CHECK (
    ${member(`${YOURS} OR (${DECIDES} AND rigour.team_actor(lessons.organization_id, lessons.team_id, lessons.actor_id)) OR ${PROPOSES}`)}
);
DROP POLICY IF EXISTS lessons_update_v2 ON rigour.lessons;
CREATE POLICY lessons_update_v2 ON rigour.lessons FOR UPDATE USING (
    ${member(`${YOURS} OR ${DECIDES} OR ${PROPOSES}`)}
) WITH CHECK (
    ${member(`${YOURS} OR ${DECIDES} OR (${OWN} AND ${TEAM} AND lessons.state IN ('candidate', 'superseded', 'rejected'))`)}
);
DROP POLICY IF EXISTS lessons_delete_v2 ON rigour.lessons;
CREATE POLICY lessons_delete_v2 ON rigour.lessons FOR DELETE USING (
    ${member(`${OWN} AND lessons.visibility = 'personal'`)}
);
CREATE OR REPLACE FUNCTION rigour.guard_lesson() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    writer TEXT := (SELECT membership.actor_id FROM rigour.memberships membership
                    WHERE membership.db_role = current_user AND membership.organization_id = NEW.organization_id
                      AND membership.team_id = NEW.team_id);
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.id, NEW.organization_id, NEW.team_id, NEW.repository_id, NEW.actor_id, NEW.kind, NEW.subject, NEW.source, NEW.supersedes_id, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.team_id, OLD.repository_id, OLD.actor_id, OLD.kind, OLD.subject, OLD.source, OLD.supersedes_id, OLD.created_at) THEN
            RAISE EXCEPTION 'rigour.lessons: lesson % keeps its id, text, author, repository and origin as written', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        -- Only its author changes a lesson's evidence; anyone else's write keeps it as it was.
        IF writer IS DISTINCT FROM OLD.actor_id THEN
            NEW.evidence_json := OLD.evidence_json;
        END IF;
        NEW.decided_by := CASE WHEN NEW.state IS DISTINCT FROM OLD.state THEN writer ELSE OLD.decided_by END;
    ELSE
        NEW.decided_by := CASE WHEN NEW.state = 'candidate' THEN NULL ELSE writer END;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lessons_guard ON rigour.lessons;
CREATE TRIGGER lessons_guard BEFORE INSERT OR UPDATE ON rigour.lessons FOR EACH ROW EXECUTE FUNCTION rigour.guard_lesson();
-- candidate_review_version 2: the rules above. Clients and doctor read it, and check pg_policies for them.
INSERT INTO rigour.meta (key, value) VALUES ('candidate_review_version', '2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
DELETE FROM rigour.meta WHERE key = 'member_candidates_version';
`;
