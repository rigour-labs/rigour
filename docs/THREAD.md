# The task thread

Every piece of work is one **task**, whatever agents and people touch it. Its **thread** is everything Rigour saw happen
to it, in order: which agent sessions edited it, what the edit checks caught while the code was being written and
whether it was fixed before the push, what the stop review and the push gate decided, and what each review of the pull
request found, with the integrity hash of its review record.

```bash
rigour thread              # the checkout's own task
rigour thread PROJ-123     # a ticket
rigour thread feat/retry   # a branch
rigour thread '#42'        # a pull request (once a review of it ran)
rigour thread --json       # the events, for a tool or an agent
```

## The key

The task is the ticket the branch names (`feat/proj-123-retry` → `PROJ-123`) once a commit subject on the branch, or
the title of its pull request as a review recorded it (`feat(PROJ-123): retry`), writes it as a ticket; otherwise the
branch itself. The task is worked out once per commit and kept, so the after-edit hook adds about 25 ms per edit (three
`git` calls), measured on this repository. A version token in a branch name
(`pin-node-22`, `fix/utf-8-decoding`, `release-1.4`) is not a ticket, because no commit writes it that way. Events are
kept per branch, one file each, so a ticket worked on in two branches gathers both, from their first event, and two
unrelated branches never share a thread. Rigour never invents a key. A pull request joins the thread when a review of
it runs, so `#42` finds the task afterwards. A detached head has no task, and nothing is recorded.

Known limit: a team whose commit subjects write a version in upper case the way a ticket is written (`UTF-8`) can have
it read as a ticket for that branch; naming the team's project keys in configuration is not built yet.

## What is recorded

| Event | Written by | Fields |
| --- | --- | --- |
| `edit-check` | the after-edit hook | session, agent, files, findings, status |
| `stop-review` | the stop hook | session, agent, blocked, blocking, files |
| `push` | the push gate | passed, failed (checks that failed) |
| `review` | the reviewer (not a backtest) | trigger, outcome, blocking, should_fix, pr, pr_title, integrity, cost_usd, judges |
| `brief` | the briefing (prompt hook, `rigour brief`, `rigour_brief`) | session, agent, items, ids, files |
| `merge` | `rigour outcomes`, the first time it reads a merged pull request of this branch ([OUTCOMES.md](OUTCOMES.md)) | pr, merge_sha, merged_at |
| `outcome` | `rigour outcomes`, when that record settles | pr, ci, follow_ups, fixes, reverted |
| `goal` | the goal check at a stop or a push, when the branch's open pull request has a description ([GOAL.md](GOAL.md)) | moment (stop or push), declared, blocks |

Every event carries the time, the task, the branch and the commit. The text view adds what only the sequence shows:
how many findings were caught while writing, and how many of those files came back clean at a later edit check
(caught and fixed before the push).

## Where it lives

`<git folder>/rigour/threads/<branch>-<hash>.jsonl` (the hash of the exact branch name, so `a/b` and `a_b` never share a file), in the repository's common git folder: shared by its worktrees (one task
worked on in two worktrees is one thread), never in the working tree, never committed. Lines are only appended. A
thread that cannot be written is skipped: it never fails the hook or command it runs in.

## What it does not know

A thread holds what Rigour saw. An agent without Rigour's hooks, or a person in an editor, shows only through the
pushes and reviews that follow their work. A thread is local to the machine; nothing is uploaded.
