# 🏢 Rigour for Enterprise & Teams

## PostgreSQL team mode

Rigour can use a provisioned PostgreSQL database as the durable learning store while retaining SQLite for offline work. Configure it once:

```bash
rigour team configure \
  --database-url 'postgresql://USER:PASSWORD@HOST/DB?sslmode=verify-full' \
  --organization ORG_ID \
  --team TEAM_ID \
  --actor ACTOR_ID
```

An administrator can initialize the schema independently. Add `--pgvector` only when the database provides the `vector` extension:

```bash
rigour team init-schema \
  --database-url 'postgresql://ADMIN:PASSWORD@HOST/DB?sslmode=verify-full' \
  --pgvector
```

The administrator must provision one non-owner login role and one `rigour.memberships` row per user. Example for a disposable test database:

```sql
CREATE ROLE rigour_alice LOGIN PASSWORD 'replace-me';
GRANT USAGE ON SCHEMA rigour TO rigour_alice;
GRANT SELECT ON rigour.meta, rigour.memberships TO rigour_alice;
GRANT SELECT, INSERT, UPDATE ON rigour.lessons, rigour.lesson_embeddings TO rigour_alice;
INSERT INTO rigour.memberships
  (db_role, organization_id, team_id, actor_id, role)
VALUES ('rigour_alice', 'acme', 'platform', 'alice', 'owner');
```

Do not use the schema owner as the application login because table owners bypass row-level security unless PostgreSQL is explicitly configured otherwise. `rigour team doctor` checks TLS, connectivity, schema version, database role, identity membership, vector extension, index readiness, and missing embeddings. `rigour team sync --dry-run` reports queued changes without sending them. `rigour team semantic-backfill` embeds existing validated lessons owned by the configured actor.

Use `rigour team semantic-search 'your engineering question'` to inspect ranked candidates and their provenance without changing policy or lesson state.

Studio synchronizes automatically. When PostgreSQL is unavailable, enforcement and learning continue locally and Studio reports `offline — changes queued`. Local evidence and outbox payloads are protected with AES-256-GCM; set `RIGOUR_LOCAL_CACHE_KEY` to a base64-encoded 32-byte managed key or Rigour creates a user-readable-only local key.

Personal lessons are private to their database actor. Publishing creates a reviewed team copy without modifying the personal source. PostgreSQL row-level security controls visibility; applications must not connect with a table-owner or RLS-bypass role.

### Organization-wide engineering knowledge

Studio's Engineering Knowledge Graph combines code structure with agent runs, verification outcomes, and promoted lessons. In team mode it can display approved knowledge originating in other repositories while keeping its source repository and provenance visible. Cross-repository proximity is advisory: it does not make a lesson enforceable without applicability validation.

Agent Teams separates the live team from retained run history and the event timeline. Historical reads are paginated so a long-running team ledger does not need to be loaded into browser memory at once.

### Why pgvector is optional

The relational lesson ledger is authoritative. pgvector is a retrieval accelerator that ranks validated personal and approved team knowledge by semantic proximity, including knowledge learned in other repositories. Every returned candidate retains its repository, owner, state, confidence, and source. Similarity cannot change state, publish knowledge, or create an enforcement rule.

Rigour uses a 384-dimension local MiniLM embedding by default, stores its model identifier with each vector, and builds an HNSW cosine index. If vector generation or PostgreSQL is unavailable, semantic team recall becomes degraded while the structural graph, SQLite cache, enforcement, and offline outbox continue.

### Local pgvector smoke test

```bash
docker run --name rigour-pgvector \
  -e POSTGRES_PASSWORD=rigour-admin \
  -p 54329:5432 -d pgvector/pgvector:pg16

node packages/rigour-cli/dist/cli.js team init-schema \
  --database-url 'postgresql://postgres:rigour-admin@127.0.0.1:54329/postgres' \
  --pgvector

docker exec -i rigour-pgvector psql -U postgres -d postgres <<'SQL'
CREATE ROLE rigour_alice LOGIN PASSWORD 'rigour-alice';
GRANT USAGE ON SCHEMA rigour TO rigour_alice;
GRANT SELECT ON rigour.meta, rigour.memberships TO rigour_alice;
GRANT SELECT, INSERT, UPDATE ON rigour.lessons, rigour.lesson_embeddings TO rigour_alice;
INSERT INTO rigour.memberships
  (db_role, organization_id, team_id, actor_id, role)
VALUES ('rigour_alice', 'acme', 'platform', 'alice', 'owner');
SQL

node packages/rigour-cli/dist/cli.js team configure \
  --database-url 'postgresql://rigour_alice:rigour-alice@127.0.0.1:54329/postgres' \
  --organization acme --team platform --actor alice --pgvector

node packages/rigour-cli/dist/cli.js team doctor
node packages/rigour-cli/dist/cli.js team sync --dry-run
node packages/rigour-cli/dist/cli.js team sync
node packages/rigour-cli/dist/cli.js team semantic-backfill
node packages/rigour-cli/dist/cli.js team semantic-search 'safe database migration'
```

The final search can legitimately return an empty candidate list until normal agent work has produced a validated lesson. Do not insert synthetic production knowledge merely to make the demo non-empty.

### Two-user acceptance test

1. Provision `rigour_alice` and `rigour_bob` with distinct actor IDs in the same organization and team.
2. Configure Alice, create and validate a personal lesson, then run `rigour team sync` and `rigour team semantic-backfill`.
3. Confirm Bob cannot retrieve Alice's personal lesson.
4. Publish a reviewed team copy as Alice (role `sme` or `owner`) and synchronize.
5. Confirm Bob can retrieve the team copy and sees Alice, the source repository, evidence, state, confidence, and provenance.
6. Stop PostgreSQL, create evidence locally, and confirm Studio says `offline — changes queued` while checks still run.
7. Restore PostgreSQL, run `rigour team sync` twice, and confirm the second run creates no duplicate lessons or embeddings.

While Rigour is a local-first tool, it is designed to be the "Quality Firewall" for high-velocity engineering teams using AI.

## 🚀 CI Integration: GitHub Actions

Ensuring that no code—agent-generated or otherwise—hits your main branch without meeting standards.

```yaml
name: Rigour Quality Gate

on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - run: npm install
      
      # The --ci flag ensures a non-zero exit on any gate failure
      - name: Run Rigour Audit
        run: npx @rigour-labs/cli check --ci
        
      - name: Upload Quality Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: rigour-report
          path: rigour-report.json
```

## 📋 Team Adoption Strategy

### 1. Shared Presets
Standardize your `rigour.yml` across all microservices. Use the same `api` or `ui` packs to ensure uniform quality.

### 2. PR Annotations (Planned)
We are building automated PR annotations so that if an agent fails a gate in CI, the specific line is flagged in the PR UI with the Rigour Fix Packet as a comment.

### 3. Local-First Enforcement
Encourage developers to run `rigour check` locally before pushing. This reduces CI "noise" and keeps the feedback loop tight.

```text
# Suggested git pre-push hook
npx @rigour-labs/cli check --ci || (echo "Rigour check failed. Refactor before pushing." && exit 1)
```

## 🔒 Security & Privacy
Rigour is local-first on your filesystem. Core gates and hooks run locally. If teams enable deep cloud mode (`--deep --provider ...`), code context can be sent to the configured provider. For strict environments, enforce local deep mode only and block cloud providers in policy.
