# Contributing to Rigour

Thank you for helping. This page covers how to build and test Rigour, the rules every change follows, and
how releases work.

## Set up

You need Node 22 or later, pnpm and git.

```bash
pnpm install
pnpm build      # every package
pnpm test       # every package's tests, the release checks and the docs check
```

The repository is a pnpm monorepo:

| Package | What it is |
| --- | --- |
| `packages/rigour-core` | The checks, the review, the reviewer, storage and the team database |
| `packages/rigour-cli` | The `rigour` command, the agent hooks and Studio's server |
| `packages/rigour-mcp` | The MCP server agents call |
| `packages/rigour-studio` | Studio's web page, built into `packages/rigour-cli/studio-dist` |
| `packages/brain-*` | The local model runtime for each platform |

A change to core is seen by the CLI and the MCP server only after core is rebuilt
(`pnpm --filter @rigour-labs/core build`). A change to Studio ships only after the CLI is rebuilt, which
copies it into `studio-dist`; commit that output with the change.

To try your build on a repository: `node packages/rigour-cli/dist/bin.js review --base origin/main`.

## Rules for every change

- **Tests next to the code.** Every change comes with a `*.test.ts` beside what it changes, testing the
  behaviour a user would notice. Tests never touch a real home directory: each package's `vitest.setup.ts`
  points `RIGOUR_HOME` and `RIGOUR_AGENT_HOME` at throwaway folders, and no test runs a real agent CLI.
- **A setting exists only if code reads it.** Adding a `rigour.yml` setting means describing it in
  `scripts/docs/config-descriptions.json` and running `pnpm docs:config`; `pnpm test` fails when the
  [configuration reference](docs/CONFIG_REFERENCE.md) is out of date. Removing one means removing its
  description.
- **A check blocks only when it can show the defect.** A new check starts advisory. It joins the blocking set
  (`PROVEN_GATES` in `packages/rigour-core/src/review/quiet.ts`) only after it has been run over real merged
  pull requests and its findings were real defects. See [What Rigour checks](docs/CHECKS.md).
- **Docs describe what the code does today.** A claim the code does not make true is a bug. Update the page
  in `docs/` in the same pull request as the behaviour.
- **Rigour reviews itself.** Before you open a pull request, `rigour review --base origin/main` must show
  nothing to fix.

### Adding a check

1. Write the check in `packages/rigour-core/src/gates/` (a `Gate` the runner runs on files) or
   `packages/rigour-core/src/review/` (a check of what a change added, run by the review).
2. Register it: gates in `packages/rigour-core/src/gates/runner.ts`, review checks in
   `packages/rigour-core/src/review/review.ts`.
3. Add its settings to `ConfigSchema` in `packages/rigour-core/src/types/index.ts`, with an `enabled` switch,
   and describe them for the reference.
4. Test that it finds the defect, stays silent on the fixed code, and stays silent on look-alikes.
5. Add a row for it to [What Rigour checks](docs/CHECKS.md).

## Pull requests and releases

Pull request titles follow [conventional commits](https://www.conventionalcommits.org) and decide the
release: merging to `main` publishes to npm with semantic-release. A release is published under the
`pending` dist-tag and becomes `latest` only once every package of it installs from npm.

| Title | Release |
| --- | --- |
| `fix: …` | Patch. The default for most changes. |
| `feat: …` | Minor. Only for something a user could not do before. |
| `docs: …`, `test: …`, `chore: …`, `ci: …` | No release. |

CI runs the build, every package's tests and the accuracy suite on Linux, macOS and Windows. Keep a pull
request to one concern, and say in its description why, what you decided and how you verified it.

## Reporting a problem

Bugs and ideas: [GitHub issues](https://github.com/rigour-labs/rigour/issues). A security vulnerability:
see [Security](docs/SECURITY.md#reporting-a-vulnerability).
