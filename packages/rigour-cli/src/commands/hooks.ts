/**
 * `rigour hooks init` — Generate tool-specific hook configurations.
 *
 * Detects which AI coding tools are present (or accepts --tool flag)
 * and generates the appropriate hook files so that Rigour runs
 * quality checks after every file write/edit.
 *
 * Supported tools:
 *   - Claude Code (.claude/settings.json PostToolUse)
 *   - Cursor (.cursor/hooks.json afterFileEdit)
 *   - Cline (.clinerules/hooks/PostToolUse)
 *   - Windsurf (.windsurf/hooks.json post_write_code)
 *
 * @since v3.0.0
 */

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { runHookChecker } from '@rigour-labs/core';

type HookTool = 'claude' | 'cursor' | 'cline' | 'windsurf';

export interface HooksOptions {
    tool?: string;
    dryRun?: boolean;
    force?: boolean;
    block?: boolean;
}

export interface HooksCheckOptions {
    files?: string;
    stdin?: boolean;
    block?: boolean;
    timeout?: string;
}

interface GeneratedFile {
    path: string;
    content: string;
    executable?: boolean;
    description: string;
}

interface CheckerCommandSpec {
    command: string;
    args: string[];
}

// ── Studio event logging ─────────────────────────────────────────────

async function logStudioEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
    try {
        const rigourDir = path.join(cwd, '.rigour');
        await fs.ensureDir(rigourDir);
        const eventsPath = path.join(rigourDir, 'events.jsonl');
        const logEntry = JSON.stringify({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...event,
        }) + '\n';
        await fs.appendFile(eventsPath, logEntry);
    } catch {
        // Silent fail
    }
}

// ── Tool detection ───────────────────────────────────────────────────

const TOOL_MARKERS: Record<HookTool, string[]> = {
    claude: ['CLAUDE.md', '.claude'],
    cursor: ['.cursor', '.cursorrules'],
    cline: ['.clinerules'],
    windsurf: ['.windsurfrules', '.windsurf'],
};

function detectTools(cwd: string): HookTool[] {
    const detected: HookTool[] = [];
    for (const [tool, markers] of Object.entries(TOOL_MARKERS) as [HookTool, string[]][]) {
        for (const marker of markers) {
            if (fs.existsSync(path.join(cwd, marker))) {
                detected.push(tool);
                break;
            }
        }
    }
    return detected;
}

function resolveCheckerCommand(cwd: string): CheckerCommandSpec {
    const localPath = path.join(
        cwd, 'node_modules', '@rigour-labs', 'core', 'dist', 'hooks', 'standalone-checker.js'
    );
    if (fs.existsSync(localPath)) {
        return { command: 'node', args: [localPath] };
    }
    return { command: 'rigour', args: ['hooks', 'check'] };
}

function shellEscape(arg: string): string {
    if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(arg)) {
        return arg;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function checkerToShellCommand(spec: CheckerCommandSpec): string {
    return [spec.command, ...spec.args].map(shellEscape).join(' ');
}

// ── Tool resolution (from --tool flag or auto-detect) ────────────────

const ALL_TOOLS: HookTool[] = ['claude', 'cursor', 'cline', 'windsurf'];

function resolveTools(cwd: string, toolFlag?: string): HookTool[] {
    if (toolFlag === 'all') {
        return ALL_TOOLS;
    }
    if (toolFlag) {
        const requested = toolFlag.split(',').map(t => t.trim().toLowerCase()) as HookTool[];
        const valid = requested.filter(t => ALL_TOOLS.includes(t));
        if (valid.length === 0) {
            console.error(chalk.red(`Unknown tool: ${toolFlag}. Valid: claude, cursor, cline, windsurf, all`));
            process.exit(1);
        }
        return valid;
    }

    // Auto-detect
    const detected = detectTools(cwd);
    if (detected.length === 0) {
        console.log(chalk.yellow('No AI coding tools detected. Defaulting to Claude Code.'));
        console.log(chalk.dim('  Use --tool <name> to specify: claude, cursor, cline, windsurf, all\n'));
        return ['claude'];
    }

    console.log(chalk.green(`Detected tools: ${detected.join(', ')}`));
    return detected;
}

// ── Per-tool hook generators ─────────────────────────────────────────

function generateClaudeHooks(checker: CheckerCommandSpec, block: boolean): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const settings = {
        hooks: {
            PostToolUse: [{
                matcher: "Write|Edit|MultiEdit",
                hooks: [{
                    type: "command" as const,
                    command: `${checkerCommand} --files "$TOOL_INPUT_file_path"${blockFlag}`,
                }]
            }]
        }
    };

    return [{
        path: '.claude/settings.json',
        content: JSON.stringify(settings, null, 4),
        description: 'Claude Code PostToolUse hook',
    }];
}

function generateCursorHooks(checker: CheckerCommandSpec, block: boolean): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hooks = {
        version: 1,
        hooks: { afterFileEdit: [{ command: `${checkerCommand} --stdin${blockFlag}` }] }
    };

    return [{
        path: '.cursor/hooks.json',
        content: JSON.stringify(hooks, null, 4),
        description: 'Cursor afterFileEdit hook config',
    }];
}

function generateClineHooks(checker: CheckerCommandSpec, block: boolean): GeneratedFile[] {
    const script = buildClineScript(checker, block);
    return [{
        path: '.clinerules/hooks/PostToolUse',
        content: script,
        executable: true,
        description: 'Cline PostToolUse executable hook',
    }];
}

function buildClineScript(checker: CheckerCommandSpec, block: boolean): string {
    const blockArgLiteral = block ? `, '--block'` : '';
    return `#!/usr/bin/env node
/**
 * Cline PostToolUse hook for Rigour.
 * Receives JSON on stdin with { toolName, toolInput }.
 */
const WRITE_TOOLS = ['write_to_file', 'replace_in_file'];

let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
        if (!WRITE_TOOLS.includes(payload.toolName)) {
            process.stdout.write(JSON.stringify({}));
            return;
        }
        const filePath = payload.toolInput?.path || payload.toolInput?.file_path;
        if (!filePath) {
            process.stdout.write(JSON.stringify({}));
            return;
        }

        const { spawnSync } = require('child_process');
        const command = ${JSON.stringify(checker.command)};
        const baseArgs = ${JSON.stringify(checker.args)};
        const proc = spawnSync(
            command,
            [...baseArgs, '--files', filePath${blockArgLiteral}],
            { encoding: 'utf-8', timeout: 5000 }
        );
        if (proc.error) {
            throw proc.error;
        }
        const raw = (proc.stdout || '').trim();
        if (!raw) {
            throw new Error(proc.stderr || 'Rigour hook checker returned no output');
        }
        const result = JSON.parse(raw);
        if (result.status === 'fail') {
            const msgs = result.failures
                .map(f => \`[rigour/\${f.gate}] \${f.file}: \${f.message}\`)
                .join('\\n');
            process.stdout.write(JSON.stringify({
                contextModification: \`\\n[Rigour] \${result.failures.length} issue(s):\\n\${msgs}\\nPlease fix before continuing.\`,
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
}

function generateWindsurfHooks(checker: CheckerCommandSpec, block: boolean): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hooks = {
        version: 1,
        hooks: { post_write_code: [{ command: `${checkerCommand} --stdin${blockFlag}` }] }
    };

    return [{
        path: '.windsurf/hooks.json',
        content: JSON.stringify(hooks, null, 4),
        description: 'Windsurf post_write_code hook config',
    }];
}

const GENERATORS: Record<HookTool, (checker: CheckerCommandSpec, block: boolean) => GeneratedFile[]> = {
    claude: generateClaudeHooks,
    cursor: generateCursorHooks,
    cline: generateClineHooks,
    windsurf: generateWindsurfHooks,
};

// ── File writing ─────────────────────────────────────────────────────

function printDryRun(files: GeneratedFile[]): void {
    console.log(chalk.cyan('\nDry run — files that would be created:\n'));
    for (const file of files) {
        console.log(chalk.bold(`  ${file.path}`));
        console.log(chalk.dim(`    ${file.description}`));
        if (file.executable) {
            console.log(chalk.dim('    (executable)'));
        }
    }
    console.log('');
}

async function writeHookFiles(
    cwd: string, files: GeneratedFile[], force: boolean
): Promise<{ written: number; skipped: number }> {
    let written = 0;
    let skipped = 0;

    for (const file of files) {
        const fullPath = path.join(cwd, file.path);
        const exists = await fs.pathExists(fullPath);

        if (exists && !force) {
            console.log(chalk.yellow(`  SKIP ${file.path} (already exists, use --force to overwrite)`));
            skipped++;
            continue;
        }

        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, file.content, 'utf-8');

        if (file.executable) {
            await fs.chmod(fullPath, 0o755);
        }

        console.log(chalk.green(`  CREATE ${file.path}`));
        console.log(chalk.dim(`         ${file.description}`));
        written++;
    }

    return { written, skipped };
}

// ── Next-steps guidance ──────────────────────────────────────────────

const NEXT_STEPS: Record<HookTool, string> = {
    claude: 'Claude Code: Hooks are active immediately. Rigour runs after every Write/Edit.',
    cursor: 'Cursor: Reload window (Cmd+Shift+P > Reload). Check Output > Hooks panel for logs.',
    cline: 'Cline: Hook is active. Quality feedback appears in agent context on violations.',
    windsurf: 'Windsurf: Reload editor. Check terminal for Rigour output after Cascade writes.',
};

function printNextSteps(tools: HookTool[]): void {
    console.log(chalk.cyan('\nNext steps:'));
    for (const tool of tools) {
        console.log(chalk.dim(`  ${NEXT_STEPS[tool]}`));
    }
    console.log('');
}

// ── Main command entry point ─────────────────────────────────────────

export async function hooksInitCommand(cwd: string, options: HooksOptions = {}): Promise<void> {
    console.log(chalk.blue('\nRigour Hooks Setup\n'));

    await logStudioEvent(cwd, {
        type: 'tool_call',
        tool: 'rigour_hooks_init',
        arguments: { tool: options.tool, dryRun: options.dryRun },
    });

    const tools = resolveTools(cwd, options.tool);
    const checker = resolveCheckerCommand(cwd);
    const block = !!options.block;

    // Collect generated files from all tools
    const allFiles: GeneratedFile[] = [];
    for (const tool of tools) {
        allFiles.push(...GENERATORS[tool](checker, block));
    }

    if (options.dryRun) {
        printDryRun(allFiles);
        return;
    }

    const { written, skipped } = await writeHookFiles(cwd, allFiles, !!options.force);

    console.log('');
    if (written > 0) {
        console.log(chalk.green.bold(`Created ${written} hook file(s).`));
    }
    if (skipped > 0) {
        console.log(chalk.yellow(`Skipped ${skipped} existing file(s).`));
    }

    printNextSteps(tools);

    await logStudioEvent(cwd, {
        type: 'tool_response',
        tool: 'rigour_hooks_init',
        status: 'success',
        content: [{ type: 'text', text: `Generated hooks for: ${tools.join(', ')}` }],
    });
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
}

function parseStdinFiles(input: string): string[] {
    if (!input) {
        return [];
    }
    try {
        const payload = JSON.parse(input);
        if (Array.isArray(payload.files)) {
            return payload.files;
        }
        if (payload.file_path) {
            return [payload.file_path];
        }
        if (payload.toolInput?.path) {
            return [payload.toolInput.path];
        }
        if (payload.toolInput?.file_path) {
            return [payload.toolInput.file_path];
        }
        return [];
    } catch {
        return input.split('\n').map(l => l.trim()).filter(Boolean);
    }
}

export async function hooksCheckCommand(cwd: string, options: HooksCheckOptions = {}): Promise<void> {
    const timeout = options.timeout ? Number(options.timeout) : 5000;
    const files = options.stdin
        ? parseStdinFiles(await readStdin())
        : (options.files ?? '').split(',').map(f => f.trim()).filter(Boolean);

    if (files.length === 0) {
        process.stdout.write(JSON.stringify({ status: 'pass', failures: [], duration_ms: 0 }));
        return;
    }

    const result = await runHookChecker({
        cwd,
        files,
        timeout_ms: Number.isFinite(timeout) ? timeout : 5000,
    });

    process.stdout.write(JSON.stringify(result));

    if (result.status === 'fail') {
        for (const failure of result.failures) {
            const loc = failure.line ? `:${failure.line}` : '';
            process.stderr.write(`[rigour/${failure.gate}] ${failure.file}${loc}: ${failure.message}\n`);
        }
        if (options.block) {
            process.exitCode = 2;
        }
    }
}
