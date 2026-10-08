# Rigour Release Checklist

This checklist is release-blocking for end-user readiness.

## How a release reaches `latest`

`next` is the release candidate; `main` is `latest`. Pull requests target `next`.

1. **A merge to `next`** with a `feat:` or `fix:` commit: semantic-release publishes every package as a release
   candidate (`6.9.0-rc.1`, `rc.2`, ...) under the `next` dist-tag. `npm install @rigour-labs/cli` is unaffected;
   `npm install @rigour-labs/cli@next` gets the candidate.
2. **Release Gates** run on the published candidate (automatic, `scripts/release-gates.mjs`, in throwaway folders with
   their own HOME and npm cache):
   - a clean install of every package from an empty cache, failing on any deprecation warning;
   - the first commands a user runs: `init`, `check`, `review --base main --json` (it must say what it checked),
     `brief --json`, `thread --json`;
   - an upgrade from the current `latest`: a repository set up with it opens with the new version, nothing it wrote lost;
   - no credential-shaped string in any published tarball.
   **Distribution Smoke** installs the exact version with `npx` and `npm i -g` on Linux, macOS and Windows.
3. **A pull request from `next` into `main`**, merged by a maintainer once the candidate's gates are green, is the
   decision to release. Before merging it, the maintainer runs their own confidentiality sweep locally on the
   candidate's tarballs (`npm pack @rigour-labs/<package>@next`): a check for anything that must never be published,
   kept out of this repository by design. On main, semantic-release publishes the final version
   under `pending`, the same gates and smoke run on it, and only then does **Promote to latest** move `latest`, publish
   the Homebrew formula and the MCP Registry entry. **Homebrew Smoke** then installs from the tap on macOS.
4. After a release, merge `main` back into `next` so the next candidate starts from it.

Run the gates by hand on any published version: `node scripts/release-gates.mjs <version> [previous]`.

**Rollback:** point `latest` back at the previous version, package by package:
`node scripts/promote-release.mjs <previous> latest`. A version left at `pending` or `next` is never installed by
default; the next release supersedes it.

## Packaging
- [ ] `npm view @rigour-labs/cli version` returns the target release version.
- [ ] `npm view @rigour-labs/core version` matches CLI version.
- [ ] All brain packages are published at the same version:
  - [ ] `@rigour-labs/brain-darwin-arm64`
  - [ ] `@rigour-labs/brain-darwin-x64`
  - [ ] `@rigour-labs/brain-linux-x64`
  - [ ] `@rigour-labs/brain-linux-arm64`
  - [ ] `@rigour-labs/brain-win-x64`
- [ ] `npm run verify:brain-packages` passes (binary executable bits preserved).
- [ ] `npm run verify:release` passes.

## Install Channels
- [ ] `npx @rigour-labs/cli@latest check --ci` works on a clean machine.
- [ ] `npm i -g @rigour-labs/cli@latest` + `rigour --version` works on a clean machine.
- [ ] `brew install rigour-labs/tap/rigour` works on clean macOS.
- [ ] `rigour doctor` detects and reports PATH/version conflicts correctly.

## Deep Mode Behavior
- [ ] `rigour check --deep --provider local` runs local mode and prints local privacy message.
- [ ] `rigour check --deep --provider local --pro` runs local pro mode and prints local privacy message.
- [ ] `rigour check --deep -k <KEY> --provider <cloud>` runs cloud mode and prints cloud privacy message.
- [ ] If API key is configured via settings and user runs `--deep` without provider, CLI clearly states cloud default and force-local option.
- [ ] `EACCES` recovery path for `rigour-brain` works (auto-repair / managed reinstall fallback).

## Documentation
- [ ] Quick start path is clear (`check`, `check --deep`, cloud BYOK).
- [ ] Troubleshooting includes PATH/version shadowing and `EACCES`.
- [ ] Privacy wording is consistent across CLI output, MCP output, and README.

## Freeze Rule
- [ ] No feature work after this release candidate except blocker fixes.
- [ ] Any post-release change requires issue link + regression test.
