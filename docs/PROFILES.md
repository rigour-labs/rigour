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

- `--match`: path prefixes or origin remotes (`github.com/acme/*` for every repository under an owner, or an exact `github.com/acme/api`). The first profile that matches wins.
- `--home`: where this profile's `.rigour/` lives: memory, lessons, settings and keys, telemetry, review state.
- Team settings come from the profile only. Any `RIGOUR_TEAM_*` or `RIGOUR_ORGANIZATION_ID` inherited from your shell is cleared, so another organization's team can never apply. `--database-url-command` prints the database URL when Rigour needs it (from a keychain or a vault); the URL is never written to the file.
- `--github-account`: the account whose token fetches a pull request's previous review for the reviewer (`gh auth token --user`).

Profiles live in `~/.rigour/profiles.json` in your real home (or `RIGOUR_PROFILES`). Repositories that match no profile use the default home, as before. A `RIGOUR_HOME` you set yourself turns profiles off for that run: no profile replaces the home you chose or brings its team, so a run you isolate stays isolated.

## What it guarantees

- **The CLI and the hooks** apply the profile of the repository they run in before anything else loads.
- **The MCP server** applies the profile of the repository it serves (`RIGOUR_CWD`, else where it started), and refuses a tool call for a repository of another profile. A single server registered globally answers only for its own profile, never with the wrong memory or team.
- **Team sync** sends only lessons from the team's own repositories (`--repositories`); everything else stays on the machine. See [Team database](./TEAM_DATABASE.md).
- `RIGOUR_USER_MEMORY=off` keeps a server out of the memories you keep for all your repositories.
