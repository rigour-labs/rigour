/**
 * Hooks Tool Handlers
 *
 * Handlers for: rigour_hooks_check, rigour_hooks_init
 *
 * @since v3.0.0 — real-time hooks for AI coding tools
 */
import { runHookChecker, generateHookFiles } from "@rigour-labs/core";
import type { HookTool } from "@rigour-labs/core";
import fs from "fs-extra";
import path from "path";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/**
 * rigour_hooks_check — Run the fast hook checker on specific files.
 * This is the same check that runs inside IDE hooks (Claude, Cursor, Cline, Windsurf).
 * Catches: hardcoded secrets, hallucinated imports, command injection, file size.
 */
export async function handleHooksCheck(
    cwd: string,
    files: string[],
    timeout?: number,
): Promise<ToolResult> {
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
 */
export async function handleHooksInit(
    cwd: string,
    tool: string,
    force: boolean = false,
    dryRun: boolean = false,
): Promise<ToolResult> {
    try {
        const hookTool = tool as HookTool;
        const checkerCommand = 'rigour hooks check';
        const files = generateHookFiles(hookTool, checkerCommand);

        if (dryRun) {
            const preview = files.map(f => `${f.path}:\n${f.content}`).join('\n\n');
            return {
                content: [{
                    type: "text",
                    text: `[DRY RUN] Would generate ${files.length} hook file(s) for '${tool}':\n\n${preview}`,
                }],
            };
        }

        const written: string[] = [];
        const skipped: string[] = [];

        for (const file of files) {
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
