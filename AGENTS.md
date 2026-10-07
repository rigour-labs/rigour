# Agent instructions

Rigour is a pnpm monorepo: `packages/rigour-core` (checks, review, the reviewer), `rigour-cli` (the `rigour`
command, hooks, Studio's server), `rigour-mcp` (the MCP server) and `rigour-studio` (Studio's web page, built
into `packages/rigour-cli/studio-dist`). Node 22 or later.

## Build and test

```bash
pnpm install
pnpm build                                   # every package; core first if you only rebuild one
pnpm --filter @rigour-labs/core test         # or cli, mcp, studio; `pnpm test` runs them all
pnpm --filter @rigour-labs/cli exec tsc --noEmit
```

A change to core is seen by the CLI and MCP only after core is rebuilt. A change to Studio ships only after
`pnpm --filter @rigour-labs/cli build`, which copies it into `studio-dist`; commit that output too.

## Rules for this repository

- Every change comes with tests next to the code (`*.test.ts`). Tests never touch a real home directory:
  `vitest.setup.ts` points `RIGOUR_HOME` and `RIGOUR_AGENT_HOME` at throwaway folders; keep it that way.
- A `rigour.yml` setting exists only if code reads it. Adding or removing one means updating
  `scripts/docs/config-descriptions.json`; the configuration reference is generated from the schema and checked in CI.
- Pull request titles follow conventional commits and drive the release: `fix:` by default, `feat:` only for
  something a user could not do before.
- Docs describe what the code does today. A claim the code does not make true is a bug.

## Rigour

This repository uses Rigour on itself. Its hooks check your work after each edit, before you finish and before a push.

- Before you say a task is done, `rigour review --base origin/main` (or the `rigour_review` MCP tool) must show
  nothing to fix. Fix what it reports in your change.
- Before writing a new helper, ask `rigour_check_pattern` whether one already exists.
- Never edit `rigour.yml`, add an ignore, or dismiss a finding to make a check pass. Whether a finding is wrong is a person's call.
- Never push with `--no-verify`.
