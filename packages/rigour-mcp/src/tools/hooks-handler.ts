/**
 * Hooks Tool Handlers
 *
 * Handlers for: rigour_hooks_check, rigour_hooks_init
 * Now includes DLP (Data Loss Prevention) capabilities.
 *
 * @since v3.0.0 — real-time hooks for AI coding tools
 * @since v4.2.0 — AI Agent DLP layer (credential interception)
 */
import { runHookChecker, generateHookFiles } from "@rigour-labs/core";
import { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry, generateDLPHookFiles } from "@rigour-labs/core";
import type { HookTool } from "@rigour-labs/core";
import fs from "fs-extra";
import path from "path";

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
            block_on_detection: true,
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
    const input: { cwd: string; files: string[]; timeout_ms?: number } = { cwd, files };
    if (timeout) input.timeout_ms = timeout;

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
 * DLP hooks that intercept credentials before agent processing.
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
        const checkerCommand = 'rigour hooks check';

        // Generate post-output hooks (existing)
        const files = generateHookFiles(hookTool, checkerCommand);

        // Generate DLP pre-input hooks (new)
        const dlpFiles = dlp ? generateDLPHookFiles(hookTool, checkerCommand) : [];
        const allFiles = [...files, ...dlpFiles];

        if (dryRun) {
            const preview = allFiles.map(f => `${f.path}:\n${f.content.slice(0, 300)}...`).join('\n\n');
            return {
                content: [{
                    type: "text",
                    text: `[DRY RUN] Would generate ${allFiles.length} hook file(s) for '${tool}'${dlp ? ' (+ DLP)' : ''}:\n\n${preview}`,
                }],
            };
        }

        const written: string[] = [];
        const skipped: string[] = [];

        for (const file of allFiles) {
            const fullPath = path.join(cwd, file.path);

            if (!force && await fs.pathExists(fullPath)) {
                skipped.push(file.path);
                continue;
            }

            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, file.content);
            if (file.executable) {
                await fs.chmod(fullPath, 0o755);
            }
            written.push(file.path);
        }

        const parts: string[] = [];
        if (written.length > 0) parts.push(`✓ Created: ${written.join(', ')}`);
        if (skipped.length > 0) parts.push(`⊘ Skipped (exists): ${skipped.join(', ')}. Use force=true to overwrite.`);
        parts.push(`Tool: ${tool}`);
        parts.push('Checks: file-size, security-patterns, hallucinated-imports, command-injection');
        if (dlp) {
            parts.push('');
            parts.push('🛑 DLP Protection: AWS keys, API tokens, database URLs, private keys, JWTs, passwords');
            parts.push('Credentials will be intercepted BEFORE reaching the AI agent.');
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
