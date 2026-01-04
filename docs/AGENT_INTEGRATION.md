# AI Agent Integration Guide

**Supported Tools**: Cursor, Cline, VSCode Copilot, Claude Code, Gemini CLI, Codex, Antigravity, and any agent that accepts custom instructions.

Copy and paste these rules into your AI coding assistant to enforce Rigour quality gates automatically.

---

## 🤖 For Cursor (.cursorrules)

```markdown
# Rigour Code Quality Rules

You are an expert engineer. You must NEVER mark a task as "Done" until it passes the Rigour Quality Gate.

## The Protocol

1.  After writing any code, you MUST run: `npx @rigour-labs/cli check`
2.  If the check FAILS:
    *   Read the error message carefully.
    *   Apply the fix (e.g., modularize the file, remove the TODO, fix the type error).
    *   Run `npx @rigour-labs/cli check` again.
3.  If the check PASSES:
    *   You may proceed to the next task or wait for user input.

## Forbidden Actions

*   DO NOT use `// @ts-ignore` or `any` to bypass checks.
*   DO NOT leave `TODO` comments in the code.
*   DO NOT create files larger than 300 lines.
```

## 🤖 For One-Off Prompts

```text
I want you to implement this feature, but adhere to strict engineering standards.
Before you declare the task complete, run `npx @rigour-labs/cli check` to verify your work.
If there are violations, fix them immediately. Do not ask for permission to fix them.
```
