# Profiles: one machine, many organizations

If you work for more than one company, or keep side projects next to your job, each needs its own Rigour memory, lessons, settings (including model keys) and team database. A profile ties those to the repositories they belong to, so the right ones apply wherever you run Rigour: the CLI, the agent hooks and the MCP server.

## Set one up

```bash
rigour profile add acme \
  --match 'github.com/acme/*,~/work/acme' \
  --home ~/.local/share/rigour-acme \
  --organization acme --team web --actor dev-jane \
  --repositories 'github.com/acme/*' \
  --database-url-command 'security find-generic-password -s rigour-acme -w' \
  --github-account jane-acme

rigour profile which    # in a repository: the profile and home that apply
rigour profile list
```

- `--match`: path prefixes or origin remotes (`github.com/acme/*` for every repository under an owner, or an exact `github.com/acme/api`). The most specific match wins, whatever the order of the list: an exact remote or the repository's own folder over `owner/*` or a folder above it; on a tie, the earlier profile. `rigour profile which` names the pattern that won. An origin on an SSH host alias (`git@work-github:acme/api`) is compared as the host the alias names in your ssh config. Adding a profile under a name that exists replaces it where it is, and says `replaced`.
- `--home`: where this profile's `.rigour/` lives: memory, lessons, settings and keys, telemetry, review state. A path ending in `.rigour` is that folder itself, so the state is always in one directory; `profile add` prints which. A home from before 6.11.1 that already holds state one level deeper (`<home>/.rigour`) keeps using it. If `rigour doctor` says state is in both, `rigour doctor --merge-state` lists how the left-over files would join the live ones (a dry run) and `--yes` does it: nothing is deleted or overwritten, and a file both hold keeps the live one, the other renamed `<name>.merged-<date>`.
- Team settings come from the profile only. Any `RIGOUR_TEAM_*` or `RIGOUR_ORGANIZATION_ID` inherited from your shell is cleared, so another organization's team can never apply. `--database-url-command` prints the database URL when Rigour needs it (from a keychain or a vault); the URL is never written to the file.
- `--github-account`: the account whose token fetches a pull request's previous review for the reviewer (`gh auth token --user`).
- `--codex-home`: this profile's own Codex home. The codex judge runs with it as `CODEX_HOME`, so it reads this profile's login, `config.toml` and `AGENTS.md`, never another organization's. Sign in there once: `CODEX_HOME=<dir> codex login`. Without it, a profile does not run the codex judge while the shared Codex home (`CODEX_HOME`, else `~/.codex`) holds `config.toml`, `AGENTS.md` or memories: the review says so, with this fix.
- `--cursor-shared`: let the cursor judge run under this profile. cursor-agent always reads your own Cursor rules, MCP servers and settings, and has no switch to give a profile its own, so under a profile it is skipped unless you allow it here.

Profiles live in `~/.rigour/profiles.json` in your real home (or `RIGOUR_PROFILES`). Repositories that match no profile use the default home, as before. A `RIGOUR_HOME` you set yourself turns profiles off for that run: no profile replaces the home you chose or brings its team, so a run you isolate stays isolated.

## What it guarantees

- **The CLI and the hooks** apply the profile of the repository they run in before anything else loads.
- **The MCP server** applies the profile of the repository it serves (`RIGOUR_CWD`, else where it started), and refuses a tool call for a repository of another profile. A single server registered globally answers only for its own profile, never with the wrong memory or team.
- **Team sync** sends only lessons from the team's own repositories (`--repositories`); everything else stays on the machine. See [Team database](./TEAM_DATABASE.md).
- `RIGOUR_USER_MEMORY=off` keeps a server out of the memories you keep for all your repositories.
- **The reviewer's judges** read nothing another organization keeps on this machine: claude runs isolated, codex runs only in the profile's own Codex home (or when the shared one holds nothing of anyone's), cursor only when the profile allows it. A judge skipped this way is never a pass. `rigour doctor` lists which judges run isolated and which are skipped and why. See [what each judge can see](./REVIEWER.md#what-each-judge-can-see).
- **`rigour doctor`'s push-gate self-test** pushes from a scratch clone in the temp folder, under the home of the repository you ran it in. A profile whose match covers the temp folder never applies to it, so another organization's home or team is never used.
