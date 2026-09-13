# AI Agent Integration Guide

**Supported Tools**: Cursor, Cline, Claude Code, Codex, Antigravity, VSCode Copilot, and any agent that accepts custom instructions.

Rigour automatically initializes rules for your favorite AI tools:
- **Cursor**: Creates \`.cursor/rules/rigour.mdc\`
- **Cline**: Creates \`.clinerules\`
- **Universal**: Creates \`docs/AGENT_INSTRUCTIONS.md\` for all other agents (Claude Code, Antigravity, Codex)

## Rigour Skills: reusable workflows across agents

Rules keep long-lived project constraints available. **Rigour Skills** are different: they are focused workflows that tell an agent when to retrieve scoped context, how to finish with proof, and how to preserve a handoff as evidence.

```bash
# Install every shipped playbook for Codex, Cursor, and portable instructions
rigour skills install

# Or target one host and one workflow
rigour skills install context verify --target codex
rigour skills install handoff --target cursor

# Inspect what is available in this repository
rigour skills doctor
```

| Playbook | Outcome |
| --- | --- |
| `rigour-context` | Gets the smallest evidence-backed scope before exploration or edits. |
| `rigour-verify` | Requires deterministic proof and uses a Fix Packet when a check fails. |
| `rigour-handoff` | Creates a compact checkpoint so the next agent starts with verified state. |

- **Codex:** native repository skills in `.agents/skills/rigour-*/SKILL.md`.
- **Cursor:** focused slash commands in `.cursor/commands/rigour-*.md`; type `/rigour-` in Agent chat.
- **Other MCP-capable agents:** portable copies in `docs/rigour-skills/`, ready to add to their project instructions.

The installer never overwrites a team-customized playbook unless you pass `--force`. A skill records normal MCP interaction evidence, but it does not promote a rule by itself: promotion remains subject to Rigour's verification boundary.


---

## 🛡️ Rigour Engineering Protocol

The rules initialized in your project enforce the "Rigour Loop." For agents like **Cursor** and **Cline**, these are automatically picked up. For **Claude Code** or **Antigravity**, you should point the agent to \`docs/AGENT_INSTRUCTIONS.md\`.

### The Critical AI Instruction

Every agent must follow these core principles:

1.  **READ FIRST**: Always read rule files (\`.mdc\`, \`.clinerules\`, \`docs/AGENT_INSTRUCTIONS.md\`) before starting.
2.  **VERIFY WORK**: Never claim "Done" without running \`npx @rigour-labs/cli check\`.
3.  **CONNECTIVITY**: Backend code must be wired to the frontend. Service files must be connected to the UI.
4.  **PROOF**: Provide actual evidence (screenshots, terminal output, or a full flow) that the feature works.

### Commands for Agents

```bash
# Verify compliance
npx @rigour-labs/cli check

# Self-healing loop (runs an agent command until PASS)
npx @rigour-labs/cli run -- <your-agent-command>
```


## 🤖 For One-Off Prompts

```text
I want you to implement this feature, but adhere to strict engineering standards.
Before you declare the task complete, run `npx @rigour-labs/cli check` to verify your work.
If there are violations, fix them immediately. Do not ask for permission to fix them.
```
