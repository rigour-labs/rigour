# AI Agent Integration Guide

**Supported Tools**: Cursor, Cline, Claude Code, Codex, Antigravity, VSCode Copilot, and any agent that accepts custom instructions.

Rigour automatically initializes rules for your favorite AI tools:
- **Cursor**: Creates \`.cursor/rules/rigour.mdc\`
- **Cline**: Creates \`.clinerules\`
- **Universal**: Creates \`docs/AGENT_INSTRUCTIONS.md\` for all other agents (Claude Code, Antigravity, Codex)


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
