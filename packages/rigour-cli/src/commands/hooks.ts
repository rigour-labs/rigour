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
import { runHookChecker, scanInputForCredentials, formatDLPAlert, createDLPAuditEntry, generateDLPHookFiles, writeDLPBlockManifest, allowLastDLPBlock } from '@rigour-labs/core';

type HookTool = 'claude' | 'cursor' | 'cline' | 'windsurf';

export interface HooksOptions {
    tool?: string;
    dryRun?: boolean;
    force?: boolean;
    block?: boolean;
    /** Also generate DLP (pre-input credential interception) hooks */
    dlp?: boolean;
}

export interface HooksCheckOptions {
    files?: string;
    stdin?: boolean;
    block?: boolean;
    timeout?: string;
    /** Run in DLP mode: scan text for credentials instead of checking files */
    mode?: 'check' | 'dlp';
    /** Agent name for audit trail (DLP mode) */
    agent?: string;
    /** Record last DLP block detections as learned false positives (hook feedback) */
    dlpAllowLast?: boolean;
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

const MAX_EVENT_LOG_LINES = 2000;

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

        // Rotate: keep last MAX_EVENT_LOG_LINES entries to prevent unbounded growth
        await rotateEventLog(eventsPath);
    } catch {
        // Silent fail
    }
}

async function rotateEventLog(eventsPath: string): Promise<void> {
    try {
        const stat = await fs.stat(eventsPath);
        // Only check rotation when file exceeds ~500KB (avoids reading on every append)
        if (stat.size < 512 * 1024) return;

        const content = await fs.readFile(eventsPath, 'utf-8');
        const lines = content.trim().split('\n');
        if (lines.length > MAX_EVENT_LOG_LINES) {
            const trimmed = lines.slice(-MAX_EVENT_LOG_LINES).join('\n') + '\n';
            await fs.writeFile(eventsPath, trimmed);
        }
    } catch {
        // Silent fail — rotation is best-effort
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
    // 1. Try project-local node_modules (installed as dependency)
    const localPath = path.join(
        cwd, 'node_modules', '@rigour-labs', 'core', 'dist', 'hooks', 'standalone-checker.js'
    );
    if (fs.existsSync(localPath)) {
        return { command: 'node', args: [localPath] };
    }

    // 2. Try dev checkout: ESM has no __dirname, derive from import.meta.url
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const localCli = path.resolve(thisDir, '../cli.js');
    if (fs.existsSync(localCli)) {
        return { command: 'node', args: [localCli, 'hooks', 'check'] };
    }

    // 3. Fallback: assume globally installed or aliased
    return { command: 'npx', args: ['@rigour-labs/cli', 'hooks', 'check'] };
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

function generateClaudeHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hooks: Record<string, unknown[]> = {
        PostToolUse: [{
            matcher: "Write|Edit|MultiEdit",
            hooks: [{
                type: "command" as const,
                command: `${checkerCommand} --files "$TOOL_INPUT_file_path"${blockFlag}`,
            }]
        }],
    };

    // DLP: Add PreToolUse hook for credential interception
    if (dlp) {
        hooks.PreToolUse = [{
            matcher: ".*",
            hooks: [{
                type: "command" as const,
                command: `${checkerCommand} --mode dlp --stdin`,
            }]
        }];
    }

    const settings = { hooks };

    return [{
        path: '.claude/settings.json',
        content: JSON.stringify(settings, null, 4),
        description: dlp
            ? 'Claude Code hooks — PostToolUse quality checks + PreToolUse DLP credential interception'
            : 'Claude Code PostToolUse hook',
    }];
}

function generateCursorHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hookEntries: Record<string, unknown[]> = {
        afterFileEdit: [{ command: `${checkerCommand} --stdin${blockFlag}` }],
    };
    if (dlp) {
        hookEntries.beforeSubmitPrompt = [{ command: `${checkerCommand} --mode dlp --stdin` }];
    }
    const hooks = { version: 1, hooks: hookEntries };

    return [{
        path: '.cursor/hooks.json',
        content: JSON.stringify(hooks, null, 4),
        description: dlp
            ? 'Cursor hooks — afterFileEdit quality checks + beforeSubmitPrompt DLP credential interception'
            : 'Cursor afterFileEdit hook config',
    }];
}

function generateClineHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true): GeneratedFile[] {
    const files: GeneratedFile[] = [{
        path: '.clinerules/hooks/PostToolUse',
        content: buildClineScript(checker, block),
        executable: true,
        description: 'Cline PostToolUse executable hook — quality checks after file writes',
    }];

    if (dlp) {
        files.push({
            path: '.clinerules/hooks/PreToolUse',
            content: buildClineDLPScript(checker),
            executable: true,
            description: 'Cline PreToolUse DLP hook — credential interception before agent execution',
        });
    }

    return files;
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

function buildClineDLPScript(checker: CheckerCommandSpec): string {
    return `#!/usr/bin/env node
/**
 * Cline PreToolUse DLP hook for Rigour.
 * Scans tool input for credentials BEFORE agent execution.
 */
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(data);
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

        const { spawnSync } = require('child_process');
        const command = ${JSON.stringify(checker.command)};
        const baseArgs = ${JSON.stringify(checker.args)};
        const proc = spawnSync(
            command,
            [...baseArgs, '--mode', 'dlp', '--stdin'],
            // Note: joining with \\n is safe — credential patterns match within single values.
            // A credential split across two toolInput fields would be malformed regardless.
            { input: textsToScan.join('\\n'), encoding: 'utf-8', timeout: 3000 }
        );
        if (proc.error) throw proc.error;
        const raw = (proc.stdout || '').trim();
        if (!raw) {
            process.stdout.write(JSON.stringify({}));
            return;
        }
        const result = JSON.parse(raw);
        if (result.status === 'blocked') {
            const msgs = result.detections
                .map(d => \`[rigour/dlp/\${d.type}] \${d.description} → \${d.recommendation}\`)
                .join('\\n');
            process.stdout.write(JSON.stringify({
                contextModification: \`\\n🛑 [Rigour DLP] \${result.detections.length} credential(s) BLOCKED:\\n\${msgs}\\nReplace with environment variable references.\`,
            }));
            process.exit(2);
        } else {
            process.stdout.write(JSON.stringify({}));
        }
    } catch (err) {
        process.stderr.write(\`Rigour DLP hook error: \${err.message}\\n\`);
        process.stdout.write(JSON.stringify({}));
    }
});
`;
}

function generateWindsurfHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hookEntries: Record<string, unknown[]> = {
        post_write_code: [{ command: `${checkerCommand} --stdin${blockFlag}` }],
    };
    if (dlp) {
        hookEntries.pre_write_code = [{ command: `${checkerCommand} --mode dlp --stdin` }];
    }
    const hooks = { version: 1, hooks: hookEntries };

    return [{
        path: '.windsurf/hooks.json',
        content: JSON.stringify(hooks, null, 4),
        description: dlp
            ? 'Windsurf hooks — post_write_code quality checks + pre_write_code DLP credential interception'
            : 'Windsurf post_write_code hook config',
    }];
}

const GENERATORS: Record<HookTool, (checker: CheckerCommandSpec, block: boolean, dlp?: boolean) => GeneratedFile[]> = {
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
        arguments: { tool: options.tool, dryRun: options.dryRun, dlp: options.dlp },
    });

    const tools = resolveTools(cwd, options.tool);
    const checker = resolveCheckerCommand(cwd);
    const block = !!options.block;
    // DLP is ON by default — user must explicitly pass --no-dlp to disable
    const dlp = options.dlp !== false;

    // Collect generated files — each generator includes DLP hooks in the SAME config file
    const allFiles: GeneratedFile[] = [];
    for (const tool of tools) {
        allFiles.push(...GENERATORS[tool](checker, block, dlp));
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

    if (dlp) {
        console.log(chalk.red.bold('  🛑 DLP Protection ACTIVE'));
        console.log(chalk.dim('  Credentials will be intercepted BEFORE reaching AI agents.'));
        console.log(chalk.dim('  Coverage: AWS keys, API tokens, database URLs, private keys, JWTs, passwords.\n'));
    }

    await logStudioEvent(cwd, {
        type: 'tool_response',
        tool: 'rigour_hooks_init',
        status: 'success',
        content: [{ type: 'text', text: `Generated hooks for: ${tools.join(', ')}${options.dlp ? ' (+ DLP)' : ''}` }],
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
        // Direct file_path (Cursor afterFileEdit, Claude Code)
        if (payload.file_path) {
            return [payload.file_path];
        }
        // Claude Code camelCase format
        if (payload.toolInput?.path) {
            return [payload.toolInput.path];
        }
        if (payload.toolInput?.file_path) {
            return [payload.toolInput.file_path];
        }
        // Cursor postToolUse: snake_case tool_input (may be object or string)
        if (payload.tool_input) {
            const ti = payload.tool_input;
            if (typeof ti === 'object' && ti !== null) {
                if (ti.file_path) return [ti.file_path];
                if (ti.path) return [ti.path];
            }
        }
        // Cursor postToolUse: file_path inside tool_output (JSON string)
        if (typeof payload.tool_output === 'string') {
            try {
                const toolOut = JSON.parse(payload.tool_output);
                if (toolOut.file_path) return [toolOut.file_path];
            } catch {
                // tool_output wasn't JSON
            }
        }
        return [];
    } catch {
        return input.split('\n').map(l => l.trim()).filter(Boolean);
    }
}

/**
 * Detect if stdin payload is from a Cursor hook (has hook_event_name or prompt field).
 * Cursor hooks send structured JSON with specific fields and expect
 * { continue: boolean, user_message?: string } back.
 */
function isCursorHookPayload(payload: any): boolean {
    return payload && (
        typeof payload.hook_event_name === 'string' ||
        typeof payload.prompt === 'string' ||
        typeof payload.conversation_id === 'string'
    );
}

/**
 * Extract text to scan from a Cursor beforeSubmitPrompt payload.
 * The prompt field contains the user's input text.
 */
function extractCursorPromptText(payload: any): string {
    if (typeof payload.prompt === 'string') return payload.prompt;
    if (typeof payload.content === 'string') return payload.content;
    if (typeof payload.new_content === 'string') return payload.new_content;
    return '';
}

export async function hooksCheckCommand(cwd: string, options: HooksCheckOptions = {}): Promise<void> {
    // ── Learn from last DLP false positive (hook feedback loop) ──
    if (options.dlpAllowLast) {
        const count = await allowLastDLPBlock(cwd, 'hook');
        process.stdout.write(JSON.stringify({ learned: count, message: `Recorded ${count} detection(s) as false positives` }));
        return;
    }

    // ── DLP Mode: Scan text for credentials ──────────────────
    if (options.mode === 'dlp') {
        let rawInput = options.stdin
            ? await readStdin()
            : (options.files ?? ''); // Reuse files param as text in DLP mode

        if (!rawInput) {
            process.stdout.write(JSON.stringify({ continue: true }));
            return;
        }

        // Parse Cursor's structured payload to extract prompt text
        let textToScan = rawInput;
        let cursorMode = false;
        try {
            const payload = JSON.parse(rawInput);
            if (isCursorHookPayload(payload)) {
                cursorMode = true;
                textToScan = extractCursorPromptText(payload);
            }
        } catch {
            // Not JSON — scan raw text as-is
        }

        if (!textToScan) {
            process.stdout.write(JSON.stringify(cursorMode ? { continue: true } : { status: 'clean', detections: [], duration_ms: 0, scanned_length: 0 }));
            return;
        }

        const result = scanInputForCredentials(textToScan, {
            enabled: true,
            block_on_detection: options.block ?? true,
            cwd,
            use_learned_feedback: true,
        });

        // Return Cursor-compatible format if detected as Cursor hook
        if (cursorMode) {
            if (result.status === 'blocked') {
                const messages = result.detections
                    .map((d: any) => `[${d.type}] ${d.description} → ${d.recommendation}`)
                    .join('\n');
                process.stdout.write(JSON.stringify({
                    continue: false,
                    user_message: `🛑 Rigour DLP: ${result.detections.length} credential(s) detected in your prompt:\n${messages}\n\nReplace with environment variable references before submitting.\n\nIf this is a false positive, run: rigour hooks check --dlp-allow-last`,
                }));
            } else {
                process.stdout.write(JSON.stringify({ continue: true }));
            }
        } else {
            process.stdout.write(JSON.stringify(result));
        }

        if (result.status !== 'clean') {
            process.stderr.write('\n' + formatDLPAlert(result) + '\n');

            // Audit trail
            try {
                const auditEntry = createDLPAuditEntry(result, {
                    agent: options.agent ?? 'hook',
                });
                await logStudioEvent(cwd, auditEntry);
            } catch {
                // Silent
            }

            if (result.status === 'blocked') {
                try {
                    await writeDLPBlockManifest(cwd, result.detections, textToScan);
                } catch {
                    // best-effort
                }
                process.exitCode = 2;
            }
        }
        return;
    }

    // ── Standard Mode: Check files ───────────────────────────
    const timeout = options.timeout ? Number(options.timeout) : 5000;
    let rawStdin = '';
    let cursorMode = false;

    if (options.stdin) {
        rawStdin = await readStdin();
        // Detect Cursor/IDE hook payload format
        try {
            const payload = JSON.parse(rawStdin);
            if (isCursorHookPayload(payload) || typeof payload.new_content === 'string') {
                cursorMode = true;
            }
        } catch (parseErr: any) {
            // Not valid JSON — log for debugging (stderr only, stdout must stay clean)
            process.stderr.write(`[rigour-hook-debug] stdin JSON parse failed: ${parseErr?.message?.slice(0, 100)}\n`);
        }
    }

    const files = options.stdin
        ? parseStdinFiles(rawStdin)
        : (options.files ?? '').split(',').map(f => f.trim()).filter(Boolean);

    if (files.length === 0) {
        process.stdout.write(JSON.stringify(cursorMode ? { continue: true } : { status: 'pass', failures: [], duration_ms: 0 }));
        return;
    }

    const result = await runHookChecker({
        cwd,
        files,
        timeout_ms: Number.isFinite(timeout) ? timeout : 5000,
    });

    // Return Cursor-compatible format if detected as Cursor hook
    if (cursorMode) {
        if (result.status === 'fail') {
            const messages = result.failures
                .map(f => {
                    const loc = f.line ? `:${f.line}` : '';
                    return `[${f.gate}] ${f.file}${loc}: ${f.message}`;
                })
                .join('\n');
            process.stdout.write(JSON.stringify({
                continue: !options.block, // block mode = stop, otherwise warn
                user_message: `⚠️ Rigour: ${result.failures.length} issue(s) found:\n${messages}`,
            }));
        } else {
            process.stdout.write(JSON.stringify({ continue: true }));
        }
    } else {
        process.stdout.write(JSON.stringify(result));
    }

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

