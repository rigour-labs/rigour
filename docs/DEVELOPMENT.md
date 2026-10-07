# During development

What Rigour does while you and your coding agent work, and what you do with what it finds. This page
assumes Rigour is set up ([Get started](./QUICK_START.md)).

## The three moments

Rigour checks the work at three moments. Each one is a little broader and a little slower than the
one before.

| Moment | What runs | What happens on a problem |
| --- | --- | --- |
| **After every edit** | Fast checks on the file the agent just changed: secrets, imports and APIs that do not exist, unsafe promises, security patterns. Under a second or two. | The agent sees the finding at once and fixes it in the same turn. |
| **Before the agent says "done"** | The whole branch against main: findings on the lines it changed, code nothing uses, risky query shapes, a merge conflict with main. | The agent is told what to fix and keeps working, at most three times, so it can never loop forever. |
| **Before `git push`** | The same branch review, plus your own formatter, linter, type check and the tests that touch the change. Optionally the model [reviewer](./REVIEWER.md). | The push is refused, with one line per problem. |

### Which agent gets which moment

| Agent | After every edit | Before "done" | Before push |
| --- | --- | --- | --- |
| Claude Code | yes | yes | yes |
| Cursor | yes | yes | yes, through git |
| Cline, Windsurf | yes | no | yes, through git |
| Codex, or you in a terminal | no | no | yes, through git |

The push check is git's own `pre-push` hook, so it applies to every tool and to a push from your
terminal. Claude Code also checks a push before it reaches git.

## What blocks, and what does not

Rigour blocks only on what it can show is wrong. One rule decides it, the same at every moment and in
the pull request bot:

- **Blocks:** findings from checks measured on real pull requests (code nothing uses, a file nothing
  imports, offset paging, an unbounded time window, a copied function, an import or API that does not
  exist, a merge conflict, and the like), and anything critical.
- **Never blocks:** style, size and other judgement calls. They are listed as notes
  (`rigour review --notes`), never as work.
- **Only your change:** problems the code already had before your branch are counted, not listed.
  You are never asked to fix someone else's old code to get yours in.

## Reviewing a change yourself

```bash
rigour review --base origin/main     # the whole branch, as the push gate sees it
rigour review                        # only your uncommitted work
```

The answer is one of three:

- **Things to fix.** At most five are shown, each with the file and line, what is wrong and how to fix
  it. `--all` shows the rest.
- **Nothing to fix** in what the branch changed.
- **Not finished.** A check could not run, most often because dependencies are not installed. The
  output names the one command that finishes it. A review that could not run is never a pass.

`--json` gives the same result for scripts and agents.

## When a finding is wrong

Every finding from a check has a key. If it is not a bug, say so once:

```bash
rigour dismiss 3f9a1c2e7b4d8a60 --reason "the scheduler holds the lock one level up"
```

It never comes back in this repository. Commit `.rigour/dismissed.json` so your team and the pull
request bot see the same judgement. Checks a team keeps dismissing go quiet on their own
(`rigour precision` shows which).

Findings from the model reviewer work differently: whether they can be dismissed at all is your team's
decision ([The reviewer](./REVIEWER.md#how-it-learns)).

## Answering a review

When a person has reviewed your pull request, the fix round should change what they asked for and
nothing else.

```bash
rigour review --scope          # files changed since the review that no point of it named
```

It reads the latest human review on the branch's pull request, and lists every file your own commits
changed since then that no comment pointed at. Merges from main are left out, and a test next to a
file the reviewer named counts as in scope. It exits 1 when there is something to explain.

With the [reviewer](./REVIEWER.md) on, `rigour review --reviewer` also checks every point of every
human review against the code, so a fix that covered half a comment is caught before you ask for
another look. Run `rigour review --reviewer --full` as the last step before you request a review.

## Risky functions, before the pull request

```bash
rigour review-task      # the risky changed functions, and what to check in each
```

Rigour scores every changed function for risk (a removed condition, a data write, paging, auth, money,
time, concurrency) and asks specific questions about the risky ones. Your agent answers them with its
own model through the `rigour_review` MCP tool, or you do. Each answer is recorded, so the same
function is not asked about again until its code changes.

## Seeing what happened

| Command | Shows |
| --- | --- |
| `rigour studio` | A local web page: what Rigour stopped, what your agents learned, the reviewer's verdict and its settings. |
| `rigour review --status` | What the background reviewer last decided on this branch, or why it did not run. |
| `rigour doctor` | What is wired up and working here, and how to fix what is not. |
| `rigour review-stats` | How the review loop is working: reviews, findings resolved, stop checks. |

## Common situations

**The push was refused and I need to ship a fix now.** Read the lines it printed: each is one problem
with a place. If a check is wrong, dismiss its finding with a reason; that is recorded and reviewable.
`git push --no-verify` skips every check and leaves no record, so keep it for a broken Rigour, not a
finding you disagree with.

**A check says it could not run.** Install the project's dependencies (the message names the command)
and run `rigour review` again. Rigour never downloads a tool on its own.

**The agent keeps stopping on the same finding.** After three attempts the stop check lets the agent
finish and says so; the finding still blocks the push. Fix it, or dismiss it with a reason.
