/**
 * DLP Hook Templates — Pre-Input Credential Interception
 *
 * Generates tool-native hook configs that intercept user input
 * BEFORE it reaches the AI agent. Complements the existing
 * post-output templates in templates.ts.
 *
 * Hook events:
 * - Claude Code: PreToolUse matcher (all tools)
 * - Cursor: beforeFileEdit event
 * - Cline: PreToolUse executable script
 * - Windsurf: pre_write_code event
 *
 * @since v4.2.0 — AI Agent DLP layer
 */

import type { HookTool } from './types.js';

export interface GeneratedDLPHookFile {
    path: string;
    content: string;
    executable?: boolean;
    description: string;
}

/**
 * Generate DLP (pre-input) hook config files for a specific tool.
 */
export function generateDLPHookFiles(tool: HookTool, checkerCommand: string): GeneratedDLPHookFile[] {
    switch (tool) {
        case 'claude':
            return generateClaudeDLPHooks(checkerCommand);
        case 'cursor':
            return generateCursorDLPHooks(checkerCommand);
        case 'cline':
            return generateClineDLPHooks(checkerCommand);
        case 'windsurf':
            return generateWindsurfDLPHooks(checkerCommand);
        default:
            return [];
    }
}

// ── Claude Code DLP Hook ──────────────────────────────────────────

function generateClaudeDLPHooks(checkerCommand: string): GeneratedDLPHookFile[] {
    // Claude Code supports PreToolUse hooks that fire BEFORE tool execution.
    // We intercept all tool uses to scan user input for credentials.
    const settings = {
        hooks: {
            PreToolUse: [
                {
                    matcher: ".*",
                    hooks: [
                        {
                            type: "command" as const,
                            command: `${checkerCommand} --mode dlp --stdin`,
                        }
                    ]
                }
            ]
        }
    };

    return [
        {
            path: '.claude/dlp-settings.json',
            content: JSON.stringify(settings, null, 4),
            description: 'Claude Code PreToolUse DLP hook — scans input for credentials before agent processing',
        },
    ];
}

// ── Cursor DLP Hook ───────────────────────────────────────────────

function generateCursorDLPHooks(checkerCommand: string): GeneratedDLPHookFile[] {
    const hooks = {
        version: 1,
        hooks: {
            beforeFileEdit: [
                {
                    command: `${checkerCommand} --mode dlp --stdin`,
                }
            ]
        }
    };

    const wrapper = `#!/usr/bin/env node
/**
 * Cursor DLP hook — scans input for credentials before agent processing.
 * Receives { file_path, new_content } on stdin.
 * Runs Rigour credential scanner on the content.
 *
 * @since v4.2.0 — AI Agent DLP
 */

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
        const textToScan = payload.new_content || payload.content || '';

        if (!textToScan) {
            process.stdout.write(JSON.stringify({ status: 'ok' }));
            return;
        }

        const { spawnSync } = require('child_process');
        const proc = spawnSync(
            'node',
            [require.resolve('@rigour-labs/core/dist/hooks/standalone-dlp-checker.js')],
            {
                input: textToScan,
                encoding: 'utf-8',
                timeout: 3000,
            }
        );

        if (proc.error) throw proc.error;

        const result = JSON.parse((proc.stdout || '').trim());
        if (result.status === 'blocked') {
            process.stderr.write('[rigour/dlp] ' + result.detections.length + ' credential(s) BLOCKED\\n');
            for (const d of result.detections) {
                process.stderr.write('  [' + d.severity.toUpperCase() + '] ' + d.description + '\\n');
                process.stderr.write('    → ' + d.recommendation + '\\n');
            }
            process.exit(2); // Block the operation
        }

        process.stdout.write(JSON.stringify({ status: 'ok' }));
    } catch (err) {
        process.stderr.write('Rigour DLP hook error: ' + err.message + '\\n');
        process.stdout.write(JSON.stringify({ status: 'ok' }));
    }
});
`;

    return [
        {
            path: '.cursor/dlp-hooks.json',
            content: JSON.stringify(hooks, null, 4),
            description: 'Cursor DLP hook config — pre-input credential scanning',
        },
        {
            path: '.cursor/rigour-dlp-hook.js',
            content: wrapper,
            executable: true,
            description: 'Cursor DLP hook wrapper — credential interception',
        },
    ];
}

// ── Cline DLP Hook ────────────────────────────────────────────────

function generateClineDLPHooks(checkerCommand: string): GeneratedDLPHookFile[] {
    const script = `#!/usr/bin/env node
/**
 * Cline PreToolUse DLP hook for Rigour.
 * Receives JSON on stdin with { toolName, toolInput }.
 * Scans tool input for credentials BEFORE execution.
 *
 * @since v4.2.0 — AI Agent DLP
 */

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);

        // Extract all string values from toolInput to scan
        const textsToScan = [];
        if (payload.toolInput) {
            for (const [key, value] of Object.entries(payload.toolInput)) {
                if (typeof value === 'string' && value.length > 5) {
                    textsToScan.push(value);
                }
            }
        }

        if (textsToScan.length === 0) {
            process.stdout.write(JSON.stringify({}));
            return;
        }

        const combined = textsToScan.join('\\n');
        const { spawnSync } = require('child_process');
        const proc = spawnSync(
            'node',
            [require.resolve('@rigour-labs/core/dist/hooks/standalone-dlp-checker.js')],
            {
                input: combined,
                encoding: 'utf-8',
                timeout: 3000,
            }
        );

        if (proc.error) throw proc.error;

        const result = JSON.parse((proc.stdout || '').trim());
        if (result.status === 'blocked') {
            const msgs = result.detections
                .map(d => '[rigour/dlp/' + d.type + '] ' + d.description + ' → ' + d.recommendation)
                .join('\\n');

            process.stdout.write(JSON.stringify({
                contextModification: '\\n🛑 [Rigour DLP] ' + result.detections.length + ' credential(s) BLOCKED before agent processing:\\n' + msgs + '\\nReplace with environment variable references.',
            }));
            process.exit(2);
        } else {
            process.stdout.write(JSON.stringify({}));
        }
    } catch (err) {
        process.stderr.write('Rigour DLP hook error: ' + err.message + '\\n');
        process.stdout.write(JSON.stringify({}));
    }
});
`;

    return [
        {
            path: '.clinerules/hooks/PreToolUse',
            content: script,
            executable: true,
            description: 'Cline PreToolUse DLP hook — credential interception before agent execution',
        },
    ];
}

// ── Windsurf DLP Hook ─────────────────────────────────────────────

function generateWindsurfDLPHooks(checkerCommand: string): GeneratedDLPHookFile[] {
    const hooks = {
        version: 1,
        hooks: {
            pre_write_code: [
                {
                    command: `${checkerCommand} --mode dlp --stdin`,
                }
            ]
        }
    };

    const wrapper = `#!/usr/bin/env node
/**
 * Windsurf DLP hook — scans input for credentials before Cascade agent processing.
 * Receives { file_path, content } on stdin.
 *
 * @since v4.2.0 — AI Agent DLP
 */

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
        const textToScan = payload.content || '';

        if (!textToScan) {
            return;
        }

        const { spawnSync } = require('child_process');
        const proc = spawnSync(
            'node',
            [require.resolve('@rigour-labs/core/dist/hooks/standalone-dlp-checker.js')],
            {
                input: textToScan,
                encoding: 'utf-8',
                timeout: 3000,
            }
        );

        if (proc.error) throw proc.error;

        const result = JSON.parse((proc.stdout || '').trim());
        if (result.status === 'blocked') {
            for (const d of result.detections) {
                process.stderr.write('[rigour/dlp] 🛑 ' + d.severity.toUpperCase() + ': ' + d.description + '\\n');
                process.stderr.write('  → ' + d.recommendation + '\\n');
            }
            process.exit(2); // Block
        }
    } catch (err) {
        process.stderr.write('Rigour DLP hook error: ' + err.message + '\\n');
    }
});
`;

    return [
        {
            path: '.windsurf/dlp-hooks.json',
            content: JSON.stringify(hooks, null, 4),
            description: 'Windsurf DLP hook config — pre-input credential scanning',
        },
        {
            path: '.windsurf/rigour-dlp-hook.js',
            content: wrapper,
            executable: true,
            description: 'Windsurf DLP hook wrapper — credential interception before Cascade',
        },
    ];
}
