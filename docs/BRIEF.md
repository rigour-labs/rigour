# The briefing

Before an agent writes, Rigour briefs it the way a senior on the team would: the repository's own rules, the team's
verified lessons and the points the team settled against, for the files the task will likely touch. At most ten items,
each cited to where it came from. The same rules and lessons the reviewer checks a change against, given before the
code exists instead of after it.

```text
Rigour briefing for PROJ-123: how this team builds the code this task will likely touch. Follow these; a [must] broken in your change blocks at review.
1. [must] Every job in `src/jobs/` must take `withLock()` before its first read; a job that reads first double-sends. (AGENTS.md)
2. src/jobs/retry.ts: Bound the retry window at both ends: `updated_at` between since and until. (learned in PR #12)
3. [settled] settled against, do not do or raise it: Wrap `retryJob` in a second try/catch. (learned in PR #14)
```

## Order and limits

1. Requirement rules for the task's files (worded as must, never, every, ...): a break of one blocks at review.
2. The team's lessons for those files: verified ones, or candidates too when the team's reviewer is shown them
   (`gates.deep.review_lessons: all`), so the agent is told what the reviewer will check.
3. Points the team settled against, so the agent neither does them nor raises them.
4. Guidance rules.

At most `brief.max_items` (default and ceiling 10). A rule from a folder's own rules file (`services/billing/AGENTS.md`)
is briefed only for a task in that folder. When nothing applies, the briefing is empty, never padded.

## The goal and the files

The goal is what the task is for: the session's first prompt (the hook), the argument or tool parameter (`rigour brief`,
`rigour_brief`), else the pull request's title and description (`rigour brief`, when `gh` can read them within five
seconds), else the branch name. The files are the ones given, else the branch's own changes and the tracked files whose
path names a word of the goal.

## Getting it

| Agent | How |
| --- | --- |
| Claude Code | `rigour hooks init --brief` installs a prompt hook: the session's first prompt is the goal, the briefing is added to the agent's context once per session |
| Any agent with MCP | `rigour_brief` with `goal` and optional `files` |
| A person, a script, any agent with a shell | `rigour brief [goal] [--files a,b] [--json]` |

Every briefing is recorded on the [task thread](./THREAD.md) (`brief`: how many items, their ids, the files), so a later
review can be read against what the agent was told.

## Off, and the kill switch

The prompt hook is **off by default**: it is installed only with `rigour hooks init --brief`. Where it is installed,
`brief.enabled: false` in `rigour.yml` (the team) or `RIGOUR_BRIEF=0` (the person) stops every briefing, the hook,
`rigour brief` and `rigour_brief` alike.

## What it is not

It is deterministic and local: no model call, nothing uploaded. It only says what the team's own rules and verified
lessons say; it does not invent advice. Whether a briefing makes an agent's work need fewer review rounds is not yet
measured on live use; see the release note.

A briefing knows the task's files only when they are given, the branch has changed them, or the goal names them. At
the very start of a session, on a new branch, that is often only the goal's words, and the briefing is thin. It is as
good as the team's recorded knowledge: a team with few verified lessons gets mostly its written rules.
