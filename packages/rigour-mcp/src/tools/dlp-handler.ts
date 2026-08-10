/**
 * DLP Tool Handlers
 *
 * Handlers for: rigour_input_scan, rigour_dlp_init
 *
 * AI Agent Data Loss Prevention — scans user input for credentials
 * before agent actions.
 *
 * @since v4.2.0 — AI Agent DLP layer
 */

import { scanInputForCredentials, formatDLPAlert, createDLPAuditEntry, generateDLPHookFiles } from '@rigour-labs/core';
import type { HookTool } from '@rigour-labs/core';
import fs from 'fs-extra';
import path from 'path';
import { getPinnedCheckerCommand } from './cli-command.js';
import { formatHookWriteResult, writeHookFiles } from './hook-file-writer.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/**
 * rigour_input_scan — Scan text for credentials before agent processing.
 *
 * This is the core DLP tool. Agents can call this to validate user input
 * may contain secrets before processing it.
 */
export async function handleInputScan(
    cwd: string,
    text: string,
    agent?: string,
    block?: boolean,
): Promise<ToolResult> {
    if (!text || text.trim().length === 0) {
        return {
            content: [{
                type: 'text',
                text: '✓ No input to scan.',
            }],
        };
    }

    const result = scanInputForCredentials(text, {
        enabled: true,
        block_on_detection: block ?? false,
        audit_log: true,
    });

    // Log to audit trail
    if (result.status !== 'clean') {
        try {
            const rigourDir = path.join(cwd, '.rigour');
            await fs.ensureDir(rigourDir);
            const eventsPath = path.join(rigourDir, 'events.jsonl');
            const auditEntry = createDLPAuditEntry(result, {
                agent: agent ?? 'mcp',
            });
            await fs.appendFile(eventsPath, JSON.stringify(auditEntry) + '\n');
        } catch {
            // Silent
        }
    }

    if (result.status === 'clean') {
        return {
            content: [{
                type: 'text',
                text: `✓ CLEAN — No credentials detected in input.\nScanned: ${result.scanned_length} chars | Duration: ${result.duration_ms}ms`,
            }],
        };
    }

    const alert = formatDLPAlert(result);

    return {
        content: [{
            type: 'text',
            text: alert,
        }],
        isError: result.status === 'blocked',
    };
}

/**
 * rigour_dlp_init — Generate DLP hook configs for AI coding tools.
 *
 * Creates pre-input hooks that warn about possible credentials before
 * agent actions.
 */
export async function handleDLPInit(
    cwd: string,
    tool: string,
    force: boolean = false,
    dryRun: boolean = false,
): Promise<ToolResult> {
    try {
        const hookTool = tool as HookTool;
        const checkerCommand = getPinnedCheckerCommand();
        const files = generateDLPHookFiles(hookTool, checkerCommand);

        if (dryRun) {
            const preview = files.map(f => `${f.path}:\n${f.content.slice(0, 200)}...`).join('\n\n');
            return {
                content: [{
                    type: 'text',
                    text: `[DRY RUN] Would generate ${files.length} DLP hook file(s) for '${tool}':\n\n${preview}`,
                }],
            };
        }

        const writeResult = await writeHookFiles(cwd, files, force);
        const parts = formatHookWriteResult(writeResult);
        parts.push(`Tool: ${tool}`);
        parts.push('DLP warnings: AWS keys, API tokens, database URLs, private keys, JWTs, passwords');
        parts.push('');
        parts.push('⚠ Possible credentials will be reported before agent actions.');

        return {
            content: [{ type: 'text', text: parts.join('\n') }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: 'text',
                text: `DLP hook init failed: ${error.message}`,
            }],
            isError: true,
        };
    }
}

/**
 * rigour_dlp_audit — Query the DLP audit log for recent credential detections.
 */
export async function handleDLPAudit(
    cwd: string,
    limit: number = 20,
): Promise<ToolResult> {
    try {
        const eventsPath = path.join(cwd, '.rigour', 'events.jsonl');

        if (!await fs.pathExists(eventsPath)) {
            return {
                content: [{
                    type: 'text',
                    text: 'No DLP events found. The audit trail is empty.',
                }],
            };
        }

        const content = await fs.readFile(eventsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        // Filter for DLP events only
        const dlpEvents = lines
            .map(line => {
                try { return JSON.parse(line); } catch { return null; }
            })
            .filter(event => event?.type === 'dlp_event')
            .slice(-limit);

        if (dlpEvents.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'No DLP interceptions found in the audit trail.',
                }],
            };
        }

        const summary = dlpEvents.map((event: any) => {
            const types = (event.detections || []).map((d: any) => d.type).join(', ');
            const severities = (event.detections || []).map((d: any) => d.severity).join(', ');
            return `[${event.timestamp}] ${event.status.toUpperCase()} | Agent: ${event.agent} | Types: ${types} | Severity: ${severities}`;
        }).join('\n');

        const totalBlocked = dlpEvents.filter((e: any) => e.status === 'blocked').length;
        const totalWarnings = dlpEvents.filter((e: any) => e.status === 'warning').length;

        return {
            content: [{
                type: 'text',
                text: `DLP Audit Trail (last ${dlpEvents.length} events)\n\nBlocked: ${totalBlocked} | Warnings: ${totalWarnings}\n\n${summary}`,
            }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: 'text',
                text: `DLP audit query failed: ${error.message}`,
            }],
            isError: true,
        };
    }
}
