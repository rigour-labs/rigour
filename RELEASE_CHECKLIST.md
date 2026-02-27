# Rigour Release Checklist

This checklist is release-blocking for end-user readiness.

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
