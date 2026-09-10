# ADR 002: Evidence learning and PostgreSQL team storage

## Status

Accepted

## Context

Rigour must remain useful when semantic models or a team database are unavailable. Teams also need private learning to follow a user across machines without turning local enforcement into a hosted service.

## Decision

- Structural indexing and the import graph are created on first use. Semantic enrichment is asynchronous and has explicit `warming`, `ready`, and `degraded` states.
- File-change hooks and checkpoints update only changed files and graph dependents.
- Normal MCP interactions create evidence records. Model output is not stored as a rule. Lessons move through `candidate`, `validated`, `promoted`, `rejected`, and `superseded` states.
- Only validated personal lessons and promoted team lessons are returned as guidance. Conflicts and provenance remain visible.
- Local mode retains existing SQLite behavior. Team mode uses PostgreSQL as the durable authority. Lesson evidence and offline-outbox payloads stored in SQLite are field-encrypted with AES-256-GCM.
- PostgreSQL roles are provisioned per user. Row-level security binds the database role to an organization, team, and actor membership.
- pgvector is optional and ranks validated knowledge for cross-repository recall. The relational lesson ledger remains authoritative; vector similarity cannot validate, publish, or enforce a lesson.
- Embeddings carry an explicit model identifier and dimension so a controlled migration is required instead of silently changing vector meaning.
- Publishing creates a team copy and preserves the personal source lesson.
- Synchronization is idempotent and automatic during normal MCP work and while Studio is running. Explicit `team doctor` and `team sync --dry-run` commands are diagnostic tools.
- Rigour maintains an Engineering Outcome Graph linking repositories, agents, runs, touched files, verification outcomes, and lessons. It complements the import graph instead of replacing it.
- Cross-repository lessons are visible as knowledge candidates. Only the separately evaluated applicable-lesson path may influence agent guidance or enforcement.
- Agent history is an append-only, paginated event ledger; the live session is a projection and never replaces retained history.

## Platform boundary

Rigour remains the product and execution-policy kernel. Model gateways and KeyHive are replaceable execution dependencies behind explicit ports; provider capacity must never mutate governance policy, and governance policy must not be hidden inside load-balancing code.

The current delivery does not claim universal model routing, opaque credential execution, mandatory third-party MCP interception, or sandbox ownership. Studio distinguishes decisions made by Rigour from restrictions reported by an editor, host sandbox, provider gateway, or human reviewer. External reports are evidence candidates until independently verified.

The long-term execution loop is `intent → authority → context → route → action → verification → outcome → learning`. This release implements the context, governance, verification, evidence, and learning portions. Routing and KeyHive integrations must arrive through separate contracts without making local enforcement depend on a remote control plane.

## Consequences

Enforcement and structural retrieval continue offline. Team learning may be stale until reconnection, which Studio reports as `offline — changes queued`. Team schema administration remains an operator responsibility; account registration, hosted authentication, billing, and a general admin portal are out of scope.

The graph visualization is an operational view, not an authority. Vector similarity and graph proximity may nominate evidence, but validation state, ownership, scope, and policy remain the decision boundary.

pgvector adds extension and embedding-model lifecycle responsibilities. Losing vector capability degrades semantic recall only; it cannot interrupt structural retrieval, local enforcement, evidence capture, or the offline outbox.
