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

## Two moments

- **The first edit of a file** (the main one). The first time a session edits a file, the agent is told what the team
  asks of that file: the requirement rules that name it or its folder, the lessons learned on it, then those a person
  widened to its folder or to the whole repository (`rigour learn-reviews --scope <id> --to folder|repo`, see
  [the reviewer](./REVIEWER.md)), the points settled against on it. At most three, each cited; nothing when nothing
  applies. Once per file per session. This is when the
  task's files are known, and so when a briefing can be specific.
- **The start of a session.** From the session's first prompt, up to ten items for the task as a whole. At that moment
  often only the goal's words are known, so this briefing is the thinner of the two.

## Order and limits

1. Requirement rules for the task's files (worded as must, never, every, ...): a break of one blocks at review.
2. The team's lessons for those files: verified ones, or candidates too when the team's reviewer is shown them
   (`gates.deep.review_lessons: all`), so the agent is told what the reviewer will check. A candidate is a review
   point as its reviewer wrote it, which no person has confirmed: often a remark about that one pull request ("Is this
   name final?", a reply to the author), not an instruction for the next task. That is why the default serves verified lessons
   only. A new team sees few lessons in its briefings until a person confirms some (Studio, or
   `rigour learn-reviews --promote`): by design, a person decides what the team's agents are told.
3. Points the team settled against, so the agent neither does them nor raises them.
4. Guidance rules.

At most `brief.max_items` (default and ceiling 10). A rules file is read one rule per top-level bullet, numbered
item or paragraph, never cut mid-sentence. A paragraph that introduces a list ("…must call one of these:") joins its
items as one rule when they are too short to be rules alone (`withLock()`); before items that are rules, it is a rule
of its own only if it asks something (must, never, should…), and otherwise it is not a rule ("The rules below:"). A
rule over 400 characters is served as its first sentence and where the whole rule is (`full rule: AGENTS.md:12`),
and a briefing stops adding items once they reach 3,000 characters together. A rule from a folder's own rules file (`services/billing/AGENTS.md`)
is briefed only for a task in that folder. When nothing applies, the briefing is empty, never padded.

A lesson is cited by the pull requests it was learned in. With a [team database](./TEAM_DATABASE.md), one a teammate
approved or rejected also says who, by the display name the team database holds, never a login or an email:
`(learned in PR #12, approved by Jane D. (team))`; "a teammate" when the administrator set no name.

## The goal and the files

A briefing is read from the repository's top, wherever in it the agent or the command starts, so a session started in
a subfolder is briefed with the same rules and lessons, and the same `rigour.yml` switch, as one started at the root.

The goal is what the task is for: the session's first prompt (the hook), the argument or tool parameter (`rigour brief`,
`rigour_brief`), else the pull request's title and description (`rigour brief`, when `gh` can read them within five
seconds), else the branch name. The files are the ones given, else the branch's own changes and the tracked files whose
path names a word of the goal.

## Getting it

| Agent | How |
| --- | --- |
| Claude Code | `rigour setup` installs it (`--no-brief` leaves it out); `rigour hooks init --brief` adds the briefing to Claude Code's hooks: each file's first edit is briefed by the credential-scan hook that already runs before every tool (`--brief`, one process for both), or by an edit hook of its own (`rigour hooks brief-file`) when that scan is off; the session's first prompt by a prompt hook (`rigour hooks brief`) |
| Any agent with MCP | `rigour_brief` with `files` and no `goal` before editing them (the team's word on each), or with a `goal` for the task as a whole |
| A person, a script, any agent with a shell | `rigour brief [goal] [--files a,b] [--json]` |

Every briefing is recorded on the [task thread](./THREAD.md) (`brief`: how many items, their ids, the files), so a later
review can be read against what the agent was told.

## Cost

The edit briefing rides on the credential-scan hook that already runs before every tool call, so it starts no process
of its own. Measured on Rigour's own repository (1,023 files, median of 9 runs): the scan alone 336 ms; with the
briefing, a file's first edit in a session 457 ms (+121 ms) and every later edit 358 ms (+22 ms, the check that the file
was already briefed). With the credential scan switched off, the edit hook of its own starts a process, about as long
as the scan alone, before every edit.

## Off, and the kill switch

`rigour setup` installs the briefing hooks (the prompt hook, and `--brief` on the credential-scan hook) unless it is
run with `--no-brief`; `rigour hooks init` installs them only with `--brief`. Where they are installed,
`brief.enabled: false` in `rigour.yml` (the team) or `RIGOUR_BRIEF=0` (the person) stops every briefing, the hook,
`rigour brief` and `rigour_brief` alike.

## What it is not

It is deterministic and local: no model call, nothing uploaded. It only says what the team's own rules and verified
lessons say; it does not invent advice. Whether a briefing makes an agent's work need fewer review rounds is not yet
measured on live use; see the release note.

A briefing knows the task's files only when they are given, the branch has changed them, or the goal names them. At
the very start of a session, on a new branch, that is often only the goal's words, and the briefing is thin. It is as
good as the team's recorded knowledge: a team with few verified lessons gets mostly its written rules.
