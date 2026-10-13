# A team's knowledge, from one review to every agent

This page follows one piece of team knowledge through a small team: how it is learned from a pull request review,
who decides it, and how it reaches every teammate's agent on the next change, while they write, before they push and
when the next pull request is reviewed. The team, people and files are made up; the commands and messages are
Rigour's.

## The team

Acme's web team keeps its code in `github.com/acme/*` and shares lessons through a team database
([Team database](./TEAM_DATABASE.md)).

| Person | Role in the team database | What they do with Rigour |
| --- | --- | --- |
| Priya | `owner` | Runs the database: created the schema, adds each person's login and membership |
| Jane | `sme` | The senior reviewer: decides which review points become rules for every agent |
| Sam | `member` | Joined this week; codes with an agent like everyone else |
| Lee | `member` | Codes with a different agent from Sam |

Everyone uses whichever agent they like. Sam's is Claude Code and Lee's is Cursor. The checks and the push gate work
the same under both. The brief reaches them differently: Claude Code is briefed automatically before each file's first
edit, and any agent with MCP, Cursor included, gets the same lessons from the `rigour_brief` tool at the start of a
task ([Coding agents and MCP](./AGENTS.md)).

## Day 1: Sam joins

Sam asks Priya for a login. Priya adds Sam's login and membership (one SQL block in
[step 2](./TEAM_DATABASE.md#2-create-a-login-and-a-membership-for-each-person)), runs `rigour team init-schema` once
so the new login gets its grants, and sends Sam a connection URL and three ids through the team's password manager.

Sam runs, once on the machine:

```bash
npm install -g @rigour-labs/cli
rigour team configure --database-url '<the URL from Priya>' \
  --organization acme --team web --actor sam --repositories 'github.com/acme/*'
```

and in the clone of `acme/api`:

```bash
rigour setup          # plain: the team's configuration is already committed
rigour team doctor    # connectivity: online, permissions ["member"], reviewDecisions: ready
rigour team sync      # brings in what the team already shares
```

**What Sam gains on day 1, before writing a line:** Sam's agent is now briefed from every lesson Jane has approved
so far and the repository's own rules (its `AGENTS.md`, `CLAUDE.md`, Cursor rules): the ones that apply to the files
it touches, most relevant first, at most three per file. Sam does not have to read months of review history to get
them.

## Week 1, during development: Lee's change

Lee asks their agent to add retries to a nightly job, in `src/jobs/retry.ts`.

- **Before it starts**, Lee's agent is briefed through `rigour_brief` on what the team asks of the files it will
  touch. Nothing about retry windows yet: the team has never written it down.
- **On every edit**, Rigour checks what the agent just wrote (under Claude Code, also files it wrote through the
  shell). A secret or a proven problem is stopped there; the rest is a note, so the agent fixes it while the file is
  still open.
- **Before the agent says "done"**, the stop review checks the whole change. Anything it would block, the agent
  fixes first.
- **Before `git push`**, the push gate runs the same checks plus the team's own formatter, linter, type check and
  the tests that touch the change. What the team set as blocking blocks, and nobody's personal setting goes below the
  team's floor ([Team setup](./TEAM_SETUP.md)).

All of it is recorded on the task's thread, so Lee and the reviewer can see what was caught and fixed before the
push: `rigour thread` ([The task thread](./THREAD.md)).

**What Lee gains:** a pull request that arrives with the mechanical problems already gone, so the human review is
about the design.

## Week 1, PR review: Jane's comment

Lee opens pull request #12. If the team turned the reviewer on (it is off until someone does;
[The reviewer](./REVIEWER.md)), it reads every human review already on the pull request, the team's lessons and the
rules the change touches, and reports at the team's own severity.

Jane reviews and writes one comment that no check could have known:

> Bound the retry window at both ends: `updated_at` between `since` and `until`.

Lee fixes it and the pull request merges.

**What Jane gains, so far:** nothing yet. Without a team memory, this comment would have to be written again on the
next person's pull request, and the one after.

## Week 1, learning: the comment becomes a rule

In the clone, someone runs `rigour learn-reviews`. It reads the merged pull requests' review comments and keeps each
thing a person asked for as a **candidate**. Jane's comment is one. A candidate is not a rule yet.

Jane, as the team's `sme`, decides:

```bash
rigour learn-reviews --list
rigour learn-reviews --promote <id> --why "unbounded windows re-ran a week of jobs in March"
```

or with one click under **How it learns** in `rigour studio`. Jane could instead mark it `--not-a-rule` (it was
about that one change), narrow it to a folder (`--scope <id> --to folder`), or take a decision back later
(`--take-back <id>`). Each decision is recorded, with Jane's display name and the date.

The next sync sends Jane's decision to the team database. Syncs are automatic: the MCP server syncs after its tool
calls and Studio every 30 seconds, and `rigour team sync` does it by hand.

A point can also become a lesson without anyone deciding, when the same thing recurs across pull requests by
different authors. Without a person deciding, nothing becomes a rule from one comment alone.

**Who can decide:** an `sme` or `owner`. When Sam or Lee, who are members, mark a candidate in their own clone, it
applies to them, and their sync reports it as `held`: a person the team chose decides what every agent is told.

## Week 2, next step: the lesson reaches everyone

Sam, who never saw pull request #12, asks their agent to change the same job.

- **Before the first edit of `src/jobs/retry.ts`**, Sam's agent is told:

  > Rigour, before you edit src/jobs/retry.ts: what this team asks of this file.<br>
  > 1\. Bound the retry window at both ends: `updated_at` between since and until. (learned in PR #12, approved by
  > Jane D. (team))

  So the agent writes it right the first time. Lee's agent gets the same lesson from `rigour_brief` when it starts
  a task on that file, and so does anyone who joins later. A person can see it with
  `rigour brief --files src/jobs/retry.ts`.
- **If an agent writes an unbounded window anyway** and the team has the reviewer on, the review of the next pull
  request finds the repeat and cites the lesson, so Jane does not have to remember it.
- **A lesson a person decided stays until a person changes it.** Jane can take it back at any time with
  `--take-back`. A lesson that came only from recurrence can also be taken back by evidence: with outcome tracking
  turned on (`learning.outcomes.mode`, off by default), a run of changes merged against it with nothing going wrong
  returns it to a candidate ([Outcomes](./OUTCOMES.md)).

## What each person gets

| Person | During development | At PR review | From learning |
| --- | --- | --- | --- |
| Sam, new | Briefed with the team's approved lessons from day 1, without reading the history | Fewer comments on what the team already settled | Benefits from decisions made before joining |
| Lee | Problems caught while the file is open, not in review | Review starts at the design, not the mechanics | A fix asked for once is not asked for again |
| Jane, senior reviewer | Briefed with the team's decisions, like everyone | Writes a point once; agents stop repeating it | Decides, with a reason, what every agent is told |
| Priya, owner | Briefed and checked, like everyone | Fewer repeated comments, like everyone | Adds a person in minutes; the team's knowledge stays in the team's own database |

## Where to start

- One person: [Get started](./QUICK_START.md).
- The whole team on the same setup: [Team setup](./TEAM_SETUP.md).
- Sharing lessons: [Team database](./TEAM_DATABASE.md), then
  [Join an existing team](./TEAM_DATABASE.md#join-an-existing-team) for each new person.
