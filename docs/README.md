# Rigour documentation

Rigour reviews the code your coding agents write, at the moments that matter: after every edit, before the
agent says it is done, before a push and on every pull request. It blocks only on what it can show is wrong,
and only on what the change itself introduced.

## Start here

| If you want to | Read |
| --- | --- |
| Try it on your own branch, then set it up for yourself | [Get started](./QUICK_START.md) |
| Know what happens while you and your agent work, and what to do with a finding | [During development](./DEVELOPMENT.md) |
| Give everyone on a repository the same setup | [Team setup](./TEAM_SETUP.md) |
| Review every pull request, or make it a required check | [Pull requests and CI](./CI.md) |
| Change what Rigour checks | [Configuration](./CONFIGURATION.md), and every setting in the [Configuration reference](./CONFIG_REFERENCE.md) |
| Approve it for your organization | [Security, privacy and network use](./SECURITY.md) and [Telemetry](../TELEMETRY.md) |

## How it works

| Topic | Page |
| --- | --- |
| Every check, what it finds, whether it blocks, and how accuracy is kept honest | [What Rigour checks](./CHECKS.md) |
| Which agents it works with, the hooks it writes for each, and its MCP tools | [Coding agents and MCP](./AGENTS.md) |
| A second opinion from your agents' own CLIs, from one judge up to a panel | [The reviewer](./REVIEWER.md) |
| A model review with an API key, or a local model | [Model review](./MODEL_REVIEW.md) |
| Measuring Rigour against your team's own past reviews | [Backtest](./BACKTEST.md) |
| The report and fix packet, for scripts and agents | [Fix packet and report](./FIX_PACKET.md) |

## For larger teams

| Topic | Page |
| --- | --- |
| Sharing what agents learn through a PostgreSQL database | [Team database](./TEAM_DATABASE.md) |
| Keeping several organizations apart on one machine | [Profiles](./PROFILES.md) |

## Contributing

How to build and test Rigour itself: [Contributing](../CONTRIBUTING.md). Design decisions are recorded in
[adr/](./adr).
