# Sharing lessons through a team database

Rigour keeps what your agents learn in a local SQLite store on each machine. A team database is an optional PostgreSQL database that lets those lessons reach your teammates' agents. Without one, everything stays on the machine where it was learned.

This page covers what is shared, how a lesson gets approved, how to set the database up, how to check it works and how to stop.

## What you get

- **Shared conventions.** When an agent saves a memory with scope `team` (through the `rigour_remember` MCP tool), it becomes a team candidate. Once a person approves it in Studio, every teammate's agent receives it.
- **Your own lessons on every machine.** With `--sync-personal`, your personal lessons are also stored in the database. Only you can read them back.
- **Optional search by meaning.** With pgvector, `rigour_recall` and `rigour_context_scope` also return team lessons that match the task by meaning, not only by keyword. See [Search by meaning with pgvector](#search-by-meaning-with-pgvector).

What it is not: the team database does not hold `rigour.yml`, findings, review results or code. Team settings live in the committed `rigour.yml` (see [Team setup](./TEAM_SETUP.md)).

## How a lesson reaches teammates

A lesson has a visibility (`personal` or `team`) and a state (`candidate`, `validated`, `promoted`, `rejected`, `superseded`). Teammates receive a lesson only when it is both `team` and `promoted`. The database enforces this with row-level security, not only the client.

| Lesson | How it starts | Who can read it in the database |
| --- | --- | --- |
| Fix lesson (an agent fixed something Rigour reported) | `personal`, `candidate`; becomes `validated` once fixes of the same kind land in two different files | Only its author, and only if sent with `--sync-personal` |
| Memory saved with scope `team` | `team`, `candidate` | Only its author |
| Memory approved in Studio | A new `team`, `promoted` copy of the candidate | Everyone in the same organization and team |

To approve a team candidate, open Studio (`rigour studio`), go to **How it learns** and click **Share with team** on the lesson. **Drop** rejects it. Approving creates a separate team copy; the original candidate is left as it was.

Database roles decide who may write team lessons:

| Role | May write |
| --- | --- |
| `member` | Personal lessons only |
| `sme` | Personal and team lessons |
| `owner` | Personal and team lessons (the same rights as `sme`) |

The approval happens on the machine that holds the candidate, so in practice the person whose agent saved the memory approves it, and that person needs the `sme` or `owner` role.

If a `member`'s agent saves a memory with scope `team`, the database refuses it. Rigour sets that item aside, marked `refused by the team database` with the database's reason, and sends the rest of the queue. Give `sme` to anyone whose agents save team memories, or tell `member` agents not to use scope `team`.

## What leaves the machine

Rigour sends a queued lesson only when all of these hold:

1. Team mode is configured on the machine.
2. The lesson's repository has an `origin` remote that matches one of the team's repositories (`--repositories`). A pattern ending in `/*` matches every repository under that owner (`github.com/acme/*`); anything else must match exactly (`github.com/acme/api`). Matching ignores the scheme, any `user@` part and case.
3. The lesson is `team`, or it is `personal` and `--sync-personal` is set.

With no `--repositories`, nothing is sent. A repository with no `origin` remote is recorded by its local path, so a remote pattern never matches it. A lesson that fails these rules is marked `not sent: <reason>` in the local queue and is never retried, even if you later add its repository to the list. A later change to the same lesson queues it again and is judged by the rules at that time.

For each lesson that is sent, the database receives:

| Field | What it holds |
| --- | --- |
| `id` | The lesson's id |
| `organization_id`, `team_id`, `actor_id` | Taken from your membership row in the database, not from the client |
| `repository_id` | A SHA-256 hash of the normalized `origin` remote URL, not the URL itself |
| `visibility`, `state`, `kind`, `confidence`, `source`, `supersedes_id` | The lesson's metadata |
| `subject` | The lesson text, for example the memory's `key: value` |
| `evidence_json` | For a memory: its key, value and when it was shared. For a fix lesson: the rule, the file paths fixed, and up to five examples with up to 300 characters of the finding's detail each |
| `created_at`, `updated_at` | Timestamps |

### Your decisions on review lessons

`rigour team sync`, the MCP server after each tool call, and Studio every 30 seconds also send the decisions you made on
the review lessons of the repository they run in (`.rigour/review-lessons.json`): accepting, rejecting, dismissing,
scoping or rewording a lesson, and approving or taking back a check compiled from one. They are read from the lessons
file, so a decision made offline or before team mode is sent on the next sync. Each is sent once; the file is read
again only when it changed. The same sync receives your teammates' decisions (see [Your team's decisions on review lessons](#your-teams-decisions-on-review-lessons)).

A decision is sent only when all of these hold:

1. The repository's `origin` matches `--repositories`, as for lessons.
2. The decision is yours: recorded under this checkout's `git config user.email`. A decision someone else made in the same clone is never sent under your name.
3. Your membership's role is `sme` or `owner`. A `member`'s decisions stay on the machine (`rigour team sync` says so under `decisions.held`).
4. The database has the review decision tables (`rigour team doctor` reports `reviewDecisions: ready`).

A correction (a lesson learned from your own edit of what an agent wrote) is not sent: its text is the code you changed.

For each decision, the database receives the lesson's id, the kind of decision, when it was made, your reason (at
most 500 characters; a rewording's previous wording is left out), and:

| Field | What it holds |
| --- | --- |
| `payload.text` | The lesson's wording, only for a decision that approves it (accepted, reworded, a compiled check approved), at most 400 characters |
| `payload.scope` | For a scope decision: `file`, `folder` or `repo` |
| `payload.file`, `payload.folder` | SHA-256 hashes of the repository id and the lesson's file or folder, never the path |
| `payload.points` | For each review point the lesson was learned from: pull request number, comment id, `person` or `bot`, when it was posted, and the reviewer as a hash of the login salted per organization (see [Data and security notes](#data-and-security-notes)). Never the comment's text |

### Your team's decisions on review lessons

The same sync receives the decisions your teammates shared on this repository's review lessons, at most 500 per sync,
for listed repositories only: a repository that is not one of the team's neither sends nor receives. They are kept
on your machine under the Rigour home (`~/.rigour/team-decisions/<repository id>.json`, file mode 600), never in the
repository's `.rigour/review-lessons.json`, so teammates' names and decisions never reach git history even when a team
commits that file. A fresh clone has none until its first sync.

Every reader (the brief, review, Studio, `rigour learn-reviews --list`) sees the lessons with the team's decisions folded
in: each received decision is on its lesson's trail with the teammate's display name, and a lesson this clone never
learned is added from the wording they approved, its file found by hashing this checkout's tracked files. For each
question (accepted or rejected, how far it reaches, its wording) the latest person decision wins:

- a teammate's decision, and a decision of yours already sent, count from when the team database received it;
- a decision of yours this machine will still send (an `sme` or `owner` in a listed repository) holds until it comes back;
- a decision this machine never sends (a `member`'s) counts from when it was made, so a later team decision wins on
  that machine.

The brief cites a lesson a teammate settled with their display name ("approved by Jane D. (team)"). Studio's **How it learns** shows each team decision on the lesson's card ("Omar K. (team) rejected it on 2026-10-09: …"), and when a later team decision settled a lesson against your own, says so ("the team decided"), with why your decision is yours only when this machine does not share it. `rigour team
doctor` says that a clone receives the team's decisions at its first sync. Evidence (a later fix, recurrence) never
overrides a person. Deciding on a lesson known only from the team takes it into
the repository's lessons file first (its wording, file and review points, without the team's decisions), and records
your decision there.

With pgvector, an embedding row is added for each validated or promoted lesson: the lesson id, the same ids as above, the model name, a SHA-256 hash of the embedded text and a 384-number vector. The vector is computed on your machine.

Never sent: source code, diffs, file contents, prompts, agent transcripts, the interaction log Rigour keeps of tool calls, memories saved with scope `repo` or `user`, findings and review results. A memory in which Rigour's credential scan finds a secret is refused before it is stored, so it cannot be shared.

Lessons are encrypted at rest in the local store and queue (AES-256-GCM, see [Data and security notes](#data-and-security-notes)). They are decrypted before they are sent, so the database holds them as plain JSON. Protect it accordingly.

## Set up a team, start to finish

Your team brings its own PostgreSQL; Rigour never hosts one. One administrator and each teammate follow these steps,
with no help from us; run end to end on a test database, the commands take a few minutes. Each step links to its details below.

1. **A PostgreSQL 13 or later database**, managed (any host's PostgreSQL service) or self-hosted, reachable from each
   teammate's machine over TLS. Note its administrator URL. See [What you need](#what-you-need).
2. **The schema**, as the administrator: `rigour team init-schema --database-url '<administrator URL>'`. Run it again
   after upgrading Rigour; it only adds what is missing. See [Create the schema](#1-create-the-schema).
3. **A login and a membership per person**, as the administrator, in SQL: the login, its grants, and one row in
   `rigour.memberships` with the person's role and a display name. Give `sme` or `owner` to whoever decides what the
   team's agents are told (they approve lessons and share decisions); `member` to everyone else. See
   [Create a login and a membership](#2-create-a-login-and-a-membership-for-each-person).
4. **Each teammate configures their machine** with their own URL, the three ids from their row, and the team's
   repositories: `rigour team configure --database-url '<their URL>' --organization <id> --team <id> --actor <id>
   --repositories 'github.com/<owner>/*'`. Without `--repositories`, nothing is shared. See
   [Set up each teammate](#set-up-each-teammate).
5. **Each teammate checks**: `rigour team doctor` says `connectivity: online`, the role under `permissions`
   (`["sme"]`), and `reviewDecisions: ready`. See [When something fails](#when-something-fails) for each message.
6. **Learn the repository's review lessons**, if no one has yet: in a clone, `rigour learn-reviews` reads the merged
   pull requests' review comments (the last 100; `--pr <n>` reads one) and keeps what people asked for as candidates.
   It reads GitHub, so it needs read access: `gh auth login`, or `GITHUB_TOKEN`. A candidate becomes a lesson when an
   `sme` or `owner` confirms it: `rigour learn-reviews --list`, then `--promote <id> --why "…"` (or `--reject`), or
   **How it learns** in `rigour studio`. Each clone can learn the same candidates from GitHub itself, so
   `.rigour/review-lessons.json` need not be committed; committing it is harmless, since teammates' decisions are never
   written to it.
7. **Bring in the decisions people already made.** In each of the team's repositories, each `sme` or `owner` runs
   `rigour team sync --dry-run` and reads `decisions`: `yours` is how many of their own decisions on review lessons the
   first sync sends; `notYours` lists, by git email, decisions in that clone someone else made, which are never sent
   from it (that person sends them from their own clone). Then `rigour team sync`. There is no separate import: the
   first sync is it, and each decision is sent once.
8. **See it on a teammate's machine**, after `rigour team sync` in a clone of the same repository (a `member`'s sync
   says its own decisions are `held`; that is expected): `rigour learn-reviews --list` lists the lesson, `rigour brief
   --files <its file>` cites it ("learned in PR #12, approved by Jane D. (team)"), and `rigour studio` → **How it
   learns** shows the decision on the lesson's card by display name and date. A rejection of a lesson that clone never
   learned has no wording to show, so it shows nowhere there until the clone learns that lesson itself.

**An empty brief at first is expected.** The brief serves verified lessons only (see [the brief](./BRIEF.md)), and a
lesson learned from review comments is verified only when a person confirms it (`rigour learn-reviews --promote`, or
Studio) or the same point recurs from different people. Until someone confirms lessons, teammates' briefings carry the
repository's rules and few lessons, by design: a person decides what the team's agents are told.

## What you need

- PostgreSQL 13 or later, managed or self-hosted. The schema uses row-level security policies, `JSONB`, `INSERT ... ON CONFLICT`, triggers and the built-in `gen_random_uuid()` (13 and later). Rigour does not check the server version; on an older server `init-schema` fails at the first statement it cannot run.
- An administrator login that can create a schema (and the `vector` extension, if you want pgvector).
- One login role per person, which the administrator creates.
- For a database that is not on `localhost`, `127.0.0.1` or `::1`: TLS. Rigour refuses a remote URL without `sslmode=require` or `sslmode=verify-full`.
- On each machine: Node 22.13 or later and the Rigour CLI (`npm install -g @rigour-labs/cli`). The PostgreSQL driver (`pg`) is an optional dependency that npm installs by default. If it was left out, Rigour says so.
- Optional, for search by meaning: the `vector` extension with HNSW index support, and Rigour's semantic search installed on each machine (`rigour setup` installs it unless you pass `--no-semantic`).

## Set up the database (administrator)

### 1. Create the schema

```bash
rigour team init-schema \
  --database-url 'postgresql://ADMIN:PASSWORD@db.example.com:5432/rigour?sslmode=verify-full'
```

Add `--pgvector` to also create the `vector` extension, the `rigour.lesson_embeddings` table and its indexes.

This creates the `rigour` schema with its tables, turns on row-level security on each and creates the policies:

- `meta`, `memberships` and `lessons`, for shared lessons. `rigour.meta` records `schema_version` 1. `rigour team doctor` and `rigour team configure` check that version and refuse any other.
- `review_decisions` and `organization_salts`, for people's decisions on review lessons (accepting, rejecting, scoping or rewording a lesson learned from code review). `rigour.meta` records `review_decisions_version` 1. `schema_version` stays 1, so earlier Rigour versions keep working against the same database. `rigour team doctor` reports `reviewDecisions: ready`, or `missing` for a database created before them; running `init-schema` again adds them. An `sme` or `owner` sends their decisions and every member receives them (see [Your decisions on review lessons](#your-decisions-on-review-lessons)).

The schema is idempotent. Running `init-schema` again adds anything missing and recreates the policies without touching lessons. One exception: with `--pgvector`, it deletes embeddings of lessons that are no longer `validated` or `promoted`. Rigour has no other migration step.

Some hosts turn on row-level security for every new table. A table with row-level security and no policy shows no rows to a non-owner login, so a correctly added member looks missing. `rigour team doctor` detects this case and tells you to run `init-schema` again, which adds the policies.

### 2. Create a login and a membership for each person

Rigour does not create roles or grant privileges. Do it with SQL, as the administrator:

```sql
CREATE ROLE rigour_jane LOGIN PASSWORD 'use-a-generated-password';
GRANT USAGE ON SCHEMA rigour TO rigour_jane;
GRANT SELECT ON rigour.meta, rigour.memberships TO rigour_jane;
GRANT SELECT, INSERT, UPDATE ON rigour.lessons TO rigour_jane;
GRANT SELECT ON rigour.organization_salts TO rigour_jane;
GRANT SELECT, INSERT ON rigour.review_decisions TO rigour_jane;
-- Only with --pgvector:
GRANT SELECT, INSERT, UPDATE ON rigour.lesson_embeddings TO rigour_jane;

INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role, display_name)
VALUES ('rigour_jane', 'acme', 'web', 'jane', 'sme', 'Jane D.');
```

- `db_role` is the login role's name. Rigour matches it against the connection's `current_user`.
- `organization_id`, `team_id` and `actor_id` are free-form ids you choose. The person configures the same three values on their machine, and the database checks them against this row.
- `role` is `member`, `sme` or `owner` (see the table above).
- `display_name` is optional: the name teammates see on a review decision this person shared. Use a name, not a login or an email. Without one, teammates see "a teammate".
- A login role can belong to a team once (the primary key is `db_role, team_id`).

Do not give anyone the schema owner's login, or a role with `BYPASSRLS`. Row-level security does not apply to a table's owner unless the table forces it, and Rigour's schema does not, so that login could read every personal lesson.

### 3. Give each person their connection URL

Each person needs a URL with their own login, for example `postgresql://rigour_jane:PASSWORD@db.example.com:5432/rigour?sslmode=verify-full`, and the three ids from their membership row. Store it where your team keeps secrets; a profile can read it from there (see below).

## Set up each teammate

Run this once per machine:

```bash
rigour team configure \
  --database-url 'postgresql://rigour_jane:PASSWORD@db.example.com:5432/rigour?sslmode=verify-full' \
  --organization acme --team web --actor jane \
  --repositories 'github.com/acme/*'
```

| Flag | Meaning |
| --- | --- |
| `--database-url` | Required. Your own login. A remote host needs `sslmode=require` or `sslmode=verify-full`. |
| `--organization`, `--team`, `--actor` | Required. The values in your membership row. |
| `--repositories` | The team's repositories, comma-separated. Without it, nothing is sent and Rigour prints a warning. |
| `--sync-personal` | Also send personal lessons. Off by default. |
| `--pgvector` | Use the team's pgvector index. The database must already have it. |
| `--initialize-schema` | Create or update the schema first. Administrator URL only. |

`configure` connects and runs the same checks as `rigour team doctor` before it saves anything. If a check fails, it prints why and saves nothing. On success it writes `~/.rigour/team.json` with file mode 600. That file includes the database URL.

From then on, sharing is automatic. The MCP server starts a sync after each tool call and Studio syncs every 30 seconds while it runs. `rigour team sync` does it by hand. Each sync takes up to 200 queued items, oldest first, and sends those the rules allow. It then receives your own lessons and the team's promoted lessons that changed since its last pull (less 15 minutes, in case a teammate's clock runs behind) into the local store.

### Several organizations on one machine

If you work in repositories of more than one organization, use a profile instead, so each organization's team applies only in its own repositories and its database URL never lands in a file:

```bash
rigour profile add acme \
  --match 'github.com/acme/*' \
  --home ~/.local/share/rigour-acme \
  --organization acme --team web --actor jane \
  --repositories 'github.com/acme/*' \
  --database-url-command 'security find-generic-password -s rigour-acme -w'
```

`--organization`, `--team` and `--actor` go together. The command runs at most once per Rigour process, with a 15-second limit; its output is used as the URL and never stored. A profile clears the team ids, repositories, URL, pgvector and personal-sync settings inherited from your shell. A profile does not carry `--pgvector` or `--sync-personal`: those come only from `rigour team configure` run in one of the profile's repositories, which saves the URL to the profile home's `team.json` as well. If the command fails, Rigour uses the URL in that file, if there is one. See [Several organizations on one machine](./PROFILES.md).

### Settings from the environment

Each setting can also come from an environment variable, which takes precedence over `team.json`. Team mode is on only when organization, team, actor and a URL are all set.

| Variable | Setting |
| --- | --- |
| `RIGOUR_TEAM_DATABASE_URL` | The database URL |
| `RIGOUR_TEAM_DATABASE_URL_COMMAND` | A command that prints the URL (used when `RIGOUR_TEAM_DATABASE_URL` is unset) |
| `RIGOUR_ORGANIZATION_ID`, `RIGOUR_TEAM_ID`, `RIGOUR_ACTOR_ID` | The three ids |
| `RIGOUR_TEAM_REPOSITORIES` | The team's repositories, comma-separated |
| `RIGOUR_TEAM_SYNC_PERSONAL` | `1` to send personal lessons; any other value to not send them |
| `RIGOUR_TEAM_SEMANTIC` | `pgvector` to use the pgvector index |
| `RIGOUR_LOCAL_CACHE_KEY` | A base64-encoded 32-byte key for the local encryption (see below) |

## Check that it works

### On each machine

```bash
rigour team doctor
```

It prints JSON. It exits with 1 when team mode is configured and the database cannot be used; with no team configured it reports `connectivity: local`. It checks, in order: the URL and its TLS setting, the connection, that your login has a membership row for the configured organization, team and actor, and that the schema version is 1. With pgvector it also checks the extension and table and counts indexed and missing lessons. On success, `connectivity` is `online`, `databaseRole` is your login and `permissions` holds your role. `queuedChanges` is the number of items not yet sent.

Failures come with the fix: an untrusted certificate chain, an unreachable host, a rejected login, a missing schema, row-level security with no policy, or a login with no membership.

```bash
rigour team sync --dry-run
```

This does not connect. It reports how many queued items would be sent (`pending`) and how many would stay on the machine (`withheld`), and, under `decisions`, how many of your decisions on this repository's review lessons the next sync sends (`yours`) and which in the clone someone else made (`notYours`). A real `rigour team sync` also reports `synced` (sent), `pulled` (received) and, under `decisions`, `sent`, `received` and any `held` reason.

### End to end, on a local database

This uses Docker and a throwaway database on your machine. A database on `127.0.0.1` needs no TLS.

```bash
docker run --name rigour-pg -e POSTGRES_PASSWORD=admin-pass -p 54329:5432 -d pgvector/pgvector:pg16

rigour team init-schema \
  --database-url 'postgresql://postgres:admin-pass@127.0.0.1:54329/postgres' --pgvector

docker exec -i rigour-pg psql -U postgres -d postgres <<'SQL'
CREATE ROLE rigour_jane LOGIN PASSWORD 'jane-pass';
GRANT USAGE ON SCHEMA rigour TO rigour_jane;
GRANT SELECT ON rigour.meta, rigour.memberships TO rigour_jane;
GRANT SELECT, INSERT, UPDATE ON rigour.lessons, rigour.lesson_embeddings TO rigour_jane;
GRANT SELECT ON rigour.organization_salts TO rigour_jane;
GRANT SELECT, INSERT ON rigour.review_decisions TO rigour_jane;
INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role, display_name)
VALUES ('rigour_jane', 'acme', 'web', 'jane', 'sme', 'Jane D.');
SQL

rigour team configure \
  --database-url 'postgresql://rigour_jane:jane-pass@127.0.0.1:54329/postgres' \
  --organization acme --team web --actor jane \
  --repositories 'github.com/acme/*' --pgvector

rigour team doctor
rigour team sync --dry-run
rigour team sync
```

`configure` here overwrites `~/.rigour/team.json`. Use a scratch `RIGOUR_HOME` or a profile if you already have a team configured.

### Between two people

1. Provision two logins in the same organization and team: Jane as `sme`, Sam as `member`. Both configure their machines with the same `--repositories`.
2. In a repository whose `origin` matches the list, Jane's agent saves a memory with scope `team`. Jane runs `rigour team sync`: `synced` is at least 1.
3. Sam runs `rigour team sync`. The candidate does not arrive: `pulled` does not count it.
4. Jane opens `rigour studio`, **How it learns**, and clicks **Share with team** on the memory, then runs `rigour team sync`.
5. Sam runs `rigour team sync` again. `pulled` now includes the team copy, and Sam's agent receives it from `rigour_recall` and `rigour_context_scope`.
6. Stop the database and use an agent as usual. Checks and learning continue locally; Studio's Storage indicator shows `offline` and the number queued. Start the database again and run `rigour team sync`: the queued items are sent.

## When something fails

Rigour shares nothing it cannot account for, and never blocks your work on the database.

- **Nothing configured, or no repositories listed.** Nothing is sent.
- **A lesson outside the team's repositories, a repository without `origin`, a personal lesson without `--sync-personal`.** Kept on the machine and marked `not sent: <reason>`. Not retried.
- **A remote URL without TLS.** Refused before any connection.
- **Membership missing.** `configure` saves nothing; `sync` stops before sending anything.
- **The database refuses one lesson** (row-level security, a constraint). That item is set aside, marked `refused by the team database: <reason>`, and the rest of the queue is sent.
- **Database unreachable or a send fails.** The item stays queued, its attempt count and error are recorded, and the sync stops. The next sync retries from the oldest item. The MCP server and Studio ignore sync errors, so checks, hooks, reviews and local learning carry on. Studio shows `offline` with the number queued.
- **Review decisions not sent**, with the reason under `decisions.held` in `rigour team sync`:
  - `repository is not one of the team's repositories` or `repository has no origin remote`: the repository neither sends nor receives. Add it to `--repositories` if it should.
  - `a member's decisions stay on this machine: an sme or owner shares them`: by design; an `sme` or `owner` can make the same decision in their clone.
  - `no git user.email here, …`: set `git config user.email` in the checkout. Without it, Rigour refuses new decisions too, so none is recorded as nobody.
  - `the team database has no review decisions yet: run rigour team init-schema`: the administrator runs it again.
  - `no membership for this login in this organization and team`: the ids in `rigour team configure` and the membership row differ.
- **A teammate's lesson shows no file.** Its file hash matched no file tracked in this checkout (a rename, or not checked out). The lesson is still served by its words.
- **Embedding model unavailable.** The lesson is sent without an embedding. Search by meaning returns `degraded` and an empty list; everything else works.

## Search by meaning with pgvector

The `lessons` table is the record. pgvector only ranks: it cannot change a lesson's state, publish it or make it a rule.

With `--pgvector`, each validated or promoted lesson you send is embedded on your machine (a 384-dimension `Xenova/all-MiniLM-L6-v2` vector over the lesson's kind, subject and source) and stored with the model's name. The index is HNSW with cosine distance. `rigour_recall` with a query and `rigour_context_scope` then include the closest team lessons above a similarity floor, each with its repository id, state, confidence and source.

```bash
rigour team semantic-backfill            # embed your validated lessons that have no vector yet (default 200 per run)
rigour team semantic-search 'safe database migration'   # what agents would be offered, as JSON
```

`semantic-backfill` embeds only lessons whose actor is you. `semantic-search` returns at most 25 candidates and an empty list until someone has sent a validated or promoted lesson. Do not insert made-up lessons to fill it.

## Bring in lessons from before team mode

Decisions on review lessons need no import: the first sync sends the ones already in the repository's lessons file (see [Set up a team, start to finish](#set-up-a-team-start-to-finish), step 7).

Lessons learned before you configured team mode are not queued. To queue a repository's personal lessons:

```bash
rigour team import-local ~/src/api ~/src/web --dry-run
rigour team import-local ~/src/api ~/src/web
rigour team sync
```

With no paths, it uses the current repository. It queues only personal lessons, assigns lessons with no owner to your actor, skips lessons owned by another actor, and never makes anything a team lesson. Running it again does not queue the same version twice. The queued lessons are personal, so they are sent only with `--sync-personal`.

## Stop sharing

- **One person stops.** Delete `~/.rigour/team.json` (or `.rigour/team.json` under the profile's home) and unset the `RIGOUR_TEAM_*`, `RIGOUR_ORGANIZATION_ID` and `RIGOUR_ACTOR_ID` variables. For a profile, run `rigour profile add` again with the same name and without the team flags; that replaces it. With no team configuration, nothing new is queued and sync does nothing. Lessons already received stay in the local store.
- **Share fewer repositories.** Run `rigour team configure` again with a shorter `--repositories`. Items already queued for the removed repositories are held back at the next sync.
- **Remove a person.** As the administrator, delete their row from `rigour.memberships`, or drop their login. Their next sync fails the membership check and sends nothing. Lessons they already sent stay in the database until you delete them.
- **Remove team lessons.** There is no Rigour command for it. Delete rows from `rigour.lessons` with SQL; their embeddings are deleted with them. Copies already received stay in teammates' local stores.

## Data and security notes

- **Visibility is enforced by the database.** Row-level security lets a login read its own membership row, its own lessons, and the team's promoted lessons in its own organization and team. It lets a login write only rows whose actor is its own, and team rows only with role `sme` or `owner`. The organization, team and actor of a sent lesson come from the membership row.
- **Review decisions are append-only.** A login can read its own team's decisions, and insert one only as `sme` or `owner` under its own actor. There is no update or delete policy, so even a login granted `UPDATE` or `DELETE` changes no row; a decision taken back is a new row. The server sets when a decision arrived and the decider's display name from the membership row; the client sets neither.
- **Reviewer hashes.** A review decision names who raised the review point only as a hash of the login, salted with a random value per organization (`rigour.organization_salts`, created for each organization when its first membership is added). A hash from one organization never matches another's. Inside a small team, someone who can read the decisions can still guess which login a hash is by hashing each teammate's login with the salt. The hashes live only in your own database, behind row-level security.
- **TLS.** Prefer `sslmode=verify-full`. With current versions of the PostgreSQL driver Rigour uses, `sslmode=require` is also verified as `verify-full` and prints a deprecation warning. If your host signs its certificate with its own root CA, keep verification on and point Node at the CA: `export NODE_EXTRA_CA_CERTS=/path/to/provider-ca.crt`, then run `rigour team doctor`.
- **The URL holds a password.** `rigour team configure` saves it in `team.json` with file mode 600. A profile's `--database-url-command` keeps it in your keychain or vault instead.
- **Local encryption.** Lesson evidence and queued items are encrypted on disk with AES-256-GCM. The key is `RIGOUR_LOCAL_CACHE_KEY` if set (base64, 32 bytes), otherwise a key Rigour creates once in `~/.rigour/team-cache.key` with file mode 600.
- **Load on the database.** A sync reads only lessons changed since that machine's last pull, through the index `rigour.lessons (organization_id, team_id, updated_at)`. The first sync on a machine reads everything it may see. The MCP server syncs after each tool call and Studio every 30 seconds. A database created by an earlier version gets the index when the administrator runs `rigour team init-schema` again.
- **Network.** The only connection is to the database URL you configure. See [Security, privacy and network use](./SECURITY.md) for every connection Rigour makes.
