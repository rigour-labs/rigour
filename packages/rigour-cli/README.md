# @rigour-labs/cli

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=4f46e5&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)

**Code review that happens while your coding agent writes.** Rigour checks the work after every edit, before
the agent says it is done and before every push, and blocks only on what it can show is wrong in the change
itself. Works with Claude Code, Cursor, Codex, Cline and Windsurf. Free, open source, and runs on your machine.

## Try it, changing nothing

On a branch with work on it (Node 22.13 or later):

```bash
npx @rigour-labs/cli review --base origin/main
```

## Set it up

```bash
npm install -g @rigour-labs/cli     # or: brew install rigour-labs/tap/rigour
rigour setup                        # personal: nothing in your working tree
rigour setup --team                 # or commit it, so everyone who clones gets the same
```

| Moment | What runs | On a problem |
| --- | --- | --- |
| After every edit | Fast checks on the file the agent changed | The agent sees it at once |
| Before the agent says "done" | The whole branch against main | The agent keeps working, at most three times |
| Before `git push` | The same, plus your own formatter, linter, type check and related tests | The push is refused, one line per problem |

## The commands you will use

| Command | What it does |
| --- | --- |
| `rigour setup` | Connects Rigour to your agents and git, and checks it works |
| `rigour review` | Reviews your change: uncommitted work, or a branch with `--base origin/main` |
| `rigour dismiss <key> --reason "…"` | Records that a finding is not a bug, so it never comes back |
| `rigour studio` | A local page: what Rigour stopped, what your agents learned, the reviewer's verdict |
| `rigour doctor` | What is working, what is not, and how to fix it |
| `rigour uninstall` | Takes out exactly what Rigour put in |

`rigour help --all` lists everything else.

## Documentation

| | |
| --- | --- |
| [Get started](https://github.com/rigour-labs/rigour/blob/main/docs/QUICK_START.md) | Try it on a branch, then set it up |
| [During development](https://github.com/rigour-labs/rigour/blob/main/docs/DEVELOPMENT.md) | What runs while you work, and what to do with a finding |
| [Team setup](https://github.com/rigour-labs/rigour/blob/main/docs/TEAM_SETUP.md) | One setup for everyone on a repository |
| [Pull requests and CI](https://github.com/rigour-labs/rigour/blob/main/docs/CI.md) | Review every pull request, or make it a required check |
| [Configuration](https://github.com/rigour-labs/rigour/blob/main/docs/CONFIGURATION.md) | What teams change, and every setting |
| [Security and network use](https://github.com/rigour-labs/rigour/blob/main/docs/SECURITY.md) | Every network call, and how to turn each off |
| [All documentation](https://github.com/rigour-labs/rigour/blob/main/docs/README.md) | |

MIT © [Rigour Labs](https://github.com/rigour-labs)
