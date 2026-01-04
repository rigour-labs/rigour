# Contributing to Rigour

We love contributions! Whether you're fixing bugs, adding new quality gates, or improving documentation, here's how you can help.

## Development Setup

1. Clone the repo
2. Install dependencies: `pnpm install`
3. Build the project: `pnpm build`
4. Run tests: `pnpm test`

## Project Structure

- `packages/rigour-core`: Core scanning and gate logic.
- `packages/rigour-cli`: The `rigour` command-line tool.
- `packages/rigour-mcp`: MCP server for AI agent integration.

## Adding a New Gate

1. Create a new file in `packages/rigour-core/src/gates/`.
2. Inherit from the `Gate` base class.
3. Add your gate to the `GateRunner` in `packages/rigour-core/src/gates/runner.ts`.
4. Update the `ConfigSchema` in `packages/rigour-core/src/types/index.ts`.
