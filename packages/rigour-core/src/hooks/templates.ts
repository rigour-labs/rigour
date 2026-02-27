/**
 * Hook configuration templates for each AI coding tool.
 *
 * Each template generates the tool-native config format:
 * - Claude Code: .claude/settings.json (PostToolUse matcher)
 * - Cursor: .cursor/hooks.json (afterFileEdit event)
 * - Cline: .clinerules/hooks/PostToolUse (executable script)
 * - Windsurf: .windsurf/hooks.json (post_write_code event)
 *
 * @since v3.0.0
 */

import type { HookTool } from './types.js';

export interface GeneratedHookFile {
    path: string;
    content: string;
    executable?: boolean;
    description: string;
}

/**
 * Generate hook config files for a specific tool.
 */
export function generateHookFiles(tool: HookTool, checkerCommand: string): GeneratedHookFile[] {
    switch (tool) {
        case 'claude':
            return generateClaudeHooks(checkerCommand);
        case 'cursor':
            return generateCursorHooks(checkerCommand);
        case 'cline':
            return generateClineHooks(checkerCommand);
        case 'windsurf':
            return generateWindsurfHooks(checkerCommand);
        default:
            return [];
    }
}

function generateClaudeHooks(checkerCommand: string): GeneratedHookFile[] {
    const settings = {
        hooks: {
            PostToolUse: [
                {
                    matcher: "Write|Edit|MultiEdit",
                    hooks: [
                        {
                            type: "command",
                            command: `${checkerCommand} --files "$TOOL_INPUT_file_path"`,
                        }
                    ]
                }
            ]
        }
    };

    return [
        {
            path: '.claude/settings.json',
            content: JSON.stringify(settings, null, 4),
            description: 'Claude Code PostToolUse hook — runs Rigour fast-check after every Write/Edit',
        },
    ];
}

function generateCursorHooks(checkerCommand: string): GeneratedHookFile[] {
    const hooks = {
        version: 1,
        hooks: {
            afterFileEdit: [
                {
                    command: `${checkerCommand} --stdin`,
                }
            ]
        }
    };

    const wrapper = `#!/usr/bin/env node
/**
 * Cursor afterFileEdit hook wrapper for Rigour.
 * Receives { file_path, old_content, new_content } on stdin.
 * Runs Rigour fast-check on the edited file.
 */
const { runHookChecker } = require('./node_modules/@rigour-labs/core/dist/hooks/checker.js');

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
        const result = await runHookChecker({
            cwd: process.cwd(),
            files: [payload.file_path],
        });

        // Write result to stdout for Cursor to consume
        process.stdout.write(JSON.stringify({ status: 'ok' }));

        // Log failures to stderr (visible in Cursor Hooks panel)
        if (result.status === 'fail') {
            for (const f of result.failures) {
                const loc = f.line ? \`:\${f.line}\` : '';
                process.stderr.write(\`[rigour/\${f.gate}] \${f.file}\${loc}: \${f.message}\\n\`);
            }
        }
    } catch (err) {
        process.stderr.write(\`Rigour hook error: \${err.message}\\n\`);
        process.stdout.write(JSON.stringify({ status: 'ok' }));
    }
});
`;

    return [
        {
            path: '.cursor/hooks.json',
            content: JSON.stringify(hooks, null, 4),
            description: 'Cursor afterFileEdit hook config',
        },
        {
            path: '.cursor/rigour-hook.js',
            content: wrapper,
            executable: true,
            description: 'Cursor hook wrapper that reads stdin and runs Rigour checker',
        },
    ];
}

function generateClineHooks(checkerCommand: string): GeneratedHookFile[] {
    const script = `#!/usr/bin/env node
/**
 * Cline PostToolUse hook for Rigour.
 * Receives JSON on stdin with { toolName, toolInput, toolOutput }.
 * Only triggers on write_to_file and replace_in_file tools.
 */
const { runHookChecker } = require('./node_modules/@rigour-labs/core/dist/hooks/checker.js');

const WRITE_TOOLS = ['write_to_file', 'replace_in_file'];

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);

        if (!WRITE_TOOLS.includes(payload.toolName)) {
            // Not a write tool, pass through
            process.stdout.write(JSON.stringify({}));
            process.exit(0);
            return;
        }

        const filePath = payload.toolInput?.path || payload.toolInput?.file_path;
        if (!filePath) {
            process.stdout.write(JSON.stringify({}));
            process.exit(0);
            return;
        }

        const result = await runHookChecker({
            cwd: process.cwd(),
            files: [filePath],
        });

        if (result.status === 'fail') {
            const messages = result.failures
                .map(f => {
                    const loc = f.line ? \`:\${f.line}\` : '';
                    return \`[rigour/\${f.gate}] \${f.file}\${loc}: \${f.message}\`;
                })
                .join('\\n');

            process.stdout.write(JSON.stringify({
                contextModification: \`\\n[Rigour Quality Gate] Found \${result.failures.length} issue(s):\\n\${messages}\\nPlease fix before continuing.\`,
            }));
        } else {
            process.stdout.write(JSON.stringify({}));
        }
    } catch (err) {
        process.stderr.write(\`Rigour hook error: \${err.message}\\n\`);
        process.stdout.write(JSON.stringify({}));
    }
});
`;

    return [
        {
            path: '.clinerules/hooks/PostToolUse',
            content: script,
            executable: true,
            description: 'Cline PostToolUse hook — runs Rigour fast-check after file writes',
        },
    ];
}

function generateWindsurfHooks(checkerCommand: string): GeneratedHookFile[] {
    const hooks = {
        version: 1,
        hooks: {
            post_write_code: [
                {
                    command: `${checkerCommand} --stdin`,
                }
            ]
        }
    };

    const wrapper = `#!/usr/bin/env node
/**
 * Windsurf post_write_code hook wrapper for Rigour.
 * Receives { file_path, content } on stdin from Cascade agent.
 * Runs Rigour fast-check on the written file.
 */
const { runHookChecker } = require('./node_modules/@rigour-labs/core/dist/hooks/checker.js');

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
        const result = await runHookChecker({
            cwd: process.cwd(),
            files: [payload.file_path],
        });

        if (result.status === 'fail') {
            for (const f of result.failures) {
                const loc = f.line ? \`:\${f.line}\` : '';
                process.stderr.write(\`[rigour/\${f.gate}] \${f.file}\${loc}: \${f.message}\\n\`);
            }
            // Exit 2 = block (if configured), exit 0 = warn only
            process.exit(0);
        }
    } catch (err) {
        process.stderr.write(\`Rigour hook error: \${err.message}\\n\`);
    }
});
`;

    return [
        {
            path: '.windsurf/hooks.json',
            content: JSON.stringify(hooks, null, 4),
            description: 'Windsurf post_write_code hook config',
        },
        {
            path: '.windsurf/rigour-hook.js',
            content: wrapper,
            executable: true,
            description: 'Windsurf hook wrapper that reads stdin and runs Rigour checker',
        },
    ];
}
