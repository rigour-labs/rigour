/**
 * Hooks Tool Handlers
 *
 * Handlers for: rigour_hooks_check, rigour_hooks_init
 * Now includes DLP (Data Loss Prevention) capabilities.
 *
 * @since v3.0.0 — real-time hooks for AI coding tools
 * @since v4.2.0 — AI Agent DLP warning layer
 */
import { runHookChecker, generateHookFiles } from "@rigour-labs/core";
import { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry, generateDLPHookFiles } from "@rigour-labs/core";
import type { HookTool } from "@rigour-labs/core";
import fs from "fs-extra";
import path from "path";
import { getPinnedCheckerCommand } from "./cli-command.js";
import { formatHookWriteResult, mergeHookFiles, writeHookFiles } from "./hook-file-writer.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/**
 * rigour_hooks_check — Run the fast hook checker on specific files.
 * This is the same check that runs inside IDE hooks (Claude, Cursor, Cline, Windsurf).
 * Catches: hardcoded secrets, hallucinated imports, command injection, file size.
 *
 * NEW in v4.2.0: When `text` param is provided, runs in DLP mode —
 * scans text for credentials instead of checking files.
 */
export async function handleHooksCheck(
    cwd: string,
    files: string[],
    timeout?: number,
    text?: string,
    agent?: string,
): Promise<ToolResult> {
    // ── DLP Mode: Scan text for credentials ──────────────────
    if (text) {
        const result = scanInputForCredentials(text, {
            enabled: true,
            block_on_detection: false,
            audit_log: true,
        });

        // Log to audit trail (with rotation to prevent unbounded growth)
        if (result.status !== 'clean') {
            try {
                const rigourDir = path.join(cwd, '.rigour');
                await fs.ensureDir(rigourDir);
                const eventsPath = path.join(rigourDir, 'events.jsonl');
                const auditEntry = createDLPAuditEntry(result, {
                    agent: agent ?? 'mcp',
                });
                await fs.appendFile(eventsPath, JSON.stringify(auditEntry) + '\n');

                // Rotate: only check when file exceeds ~500KB
                const stat = await fs.stat(eventsPath);
                if (stat.size >= 512 * 1024) {
                    const content = await fs.readFile(eventsPath, 'utf-8');
                    const lines = content.trim().split('\n');
                    if (lines.length > 2000) {
                        await fs.writeFile(eventsPath, lines.slice(-2000).join('\n') + '\n');
                    }
                }
            } catch {
                // Silent
            }
        }

        if (result.status === 'clean') {
            return {
                content: [{
                    type: "text",
                    text: `✓ CLEAN — No credentials detected in input.\nScanned: ${result.scanned_length} chars | Duration: ${result.duration_ms}ms`,
                }],
            };
        }

        return {
            content: [{
                type: "text",
                text: formatDLPAlert(result),
            }],
            isError: result.status === 'blocked',
        };
    }

    // ── Standard Mode: Check files ───────────────────────────
    const input: { cwd: string; files: string[]; timeout_ms?: number; agentId?: string } = { cwd, files };
    if (timeout) input.timeout_ms = timeout;
    if (agent) input.agentId = agent;

    const result = await runHookChecker(input);

    if (result.status === 'pass') {
        return {
            content: [{
                type: "text",
                text: `✓ PASS — ${files.length} file(s) passed all hook checks.\nDuration: ${result.duration_ms}ms`,
            }],
        };
    }

    const failureLines = result.failures.map(f =>
        `  [${f.severity.toUpperCase()}] [${f.gate}] ${f.file}:${f.line ?? '?'}\n    → ${f.message}`
    ).join('\n');

    return {
        content: [{
            type: "text",
            text: `✘ FAIL — ${result.failures.length} issue(s) found in ${files.length} file(s).\nDuration: ${result.duration_ms}ms\n\n${failureLines}`,
        }],
    };
}

/**
 * rigour_hooks_init — Generate hook configs for AI coding tools.
 *
 * NEW in v4.2.0: When `dlp` param is true, also generates pre-input
 * DLP hooks that warn about possible credentials before agent processing.
 */
export async function handleHooksInit(
    cwd: string,
    tool: string,
    force: boolean = false,
    dryRun: boolean = false,
    dlp: boolean = true,
): Promise<ToolResult> {
    try {
        const hookTool = tool as HookTool;
        const checkerCommand = getPinnedCheckerCommand();

        // Generate post-output hooks (existing)
        const files = generateHookFiles(hookTool, checkerCommand);

        // Generate DLP pre-input hooks (new)
        const dlpFiles = dlp ? generateDLPHookFiles(hookTool, checkerCommand) : [];
        const allFiles = mergeHookFiles([...files, ...dlpFiles]);

        if (dryRun) {
            const preview = allFiles.map(f => `${f.path}:\n${f.content.slice(0, 300)}...`).join('\n\n');
            return {
                content: [{
                    type: "text",
                    text: `[DRY RUN] Would generate ${allFiles.length} hook file(s) for '${tool}'${dlp ? ' (+ DLP)' : ''}:\n\n${preview}`,
                }],
            };
        }

        const writeResult = await writeHookFiles(cwd, allFiles, force);
        const parts = formatHookWriteResult(writeResult);
        parts.push(`Tool: ${tool}`);
        parts.push('Checks: file-size, security-patterns, hallucinated-imports, command-injection');
        if (dlp) {
            parts.push('');
            parts.push('⚠ DLP warnings: AWS keys, API tokens, database URLs, private keys, JWTs, passwords');
            parts.push('Possible credentials will be reported before agent actions.');
        }

        return {
            content: [{ type: "text", text: parts.join('\n') }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: "text",
                text: `Hook init failed: ${error.message}\n\nFallback: run 'npx @rigour-labs/cli hooks init --tool ${tool}' from the terminal.`,
            }],
            isError: true,
        };
    }
}
