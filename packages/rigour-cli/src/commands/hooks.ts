/**
 * `rigour hooks init`: each agent's hook configuration, for the agents the repository shows signs of
 * (or --tool), and git's pre-push hook.
 *
 *   - Claude Code: .claude/settings.json (after an edit, before "done", before a push, DLP)
 *   - Cursor: .cursor/hooks.json (after an edit, before "done", DLP)
 *   - Cline: .clinerules/hooks/ (after an edit, DLP)
 *   - Windsurf: .windsurf/hooks.json (after a write, DLP)
 */

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
    allowLastDLPBlock,
    appendTaskEvent,
    createDLPAuditEntry,
    formatDLPAlert,
    generateDLPHookFiles,
    recordInteractionEvidence,
    runHookChecker,
    countUsage,
    scanInputForCredentials,
    updateAutomaticIndexForFiles,
    writeDLPBlockManifest,
    STOP_MAX_ATTEMPTS,
    recordHookPayload,
    recordSessionBaseline,
    recordAgentWrites,
} from '@rigour-labs/core';
import type { HookCheckerResult } from '@rigour-labs/core';
import { pushGateShell, rigourUserDir } from '@rigour-labs/core';
import { groupFilesByRepo, recordEditCatches } from './hooks-check-repos.js';
import { installGitPushHook } from './hooks-git.js';
import { isRigourScript, mergeHooksInto, recordCreated } from './install-record.js';
import { agentHome, asUserLevel, installedAgents } from './personal.js';

type HookTool = 'claude' | 'cursor' | 'cline' | 'windsurf';

export interface HooksOptions {
    tool?: string;
    dryRun?: boolean;
    force?: boolean;
    block?: boolean;
    /** Also generate DLP pre-input warning hooks */
    dlp?: boolean;
    /** Also brief the agent from its first prompt (Claude Code's UserPromptSubmit). Off unless asked. */
    brief?: boolean;
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
    /** Record last DLP warning detections as learned false positives (hook feedback) */
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

function getHookCliVersion(): string {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(thisDir, '../../package.json');
    const pkg = fs.readJsonSync(packagePath) as { version?: string };
    const version = pkg.version?.trim();
    if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('Unable to resolve the installed Rigour CLI version');
    }
    return version;
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

function resolveCheckerCommand(): CheckerCommandSpec {
    return {
        command: 'npx',
        args: ['--yes', `@rigour-labs/cli@${getHookCliVersion()}`, 'hooks', 'check'],
    };
}

/** This CLI, pinned to its version, as a hook runs it (`npx --yes @rigour-labs/cli@6.6.6`). */
export function pinnedCliCommand(): string {
    const checker = resolveCheckerCommand();
    return checkerToShellCommand({ command: checker.command, args: checker.args.slice(0, -2) });
}

/** The stop hook: same pinned CLI, `hooks stop` instead of `hooks check`. */
function stopHookCommand(checker: CheckerCommandSpec, tool: 'claude' | 'cursor'): string {
    const args = checker.args[checker.args.length - 1] === 'check' ? [...checker.args.slice(0, -1), 'stop'] : [...checker.args, 'stop'];
    return checkerToShellCommand({ command: checker.command, args: [...args, '--tool', tool] });
}

/** The briefing hook: the checker command with `brief` in place of `check`. */
function briefHookCommand(checker: CheckerCommandSpec): string {
    const args = checker.args[checker.args.length - 1] === 'check' ? [...checker.args.slice(0, -1), 'brief'] : [...checker.args, 'brief'];
    return checkerToShellCommand({ command: checker.command, args });
}

/** Seconds Claude Code waits for the briefing: it reads local files only. */
const BRIEF_HOOK_TIMEOUT_S = 20;

/** Seconds Claude Code waits for the stop review before letting the agent stop. */
const STOP_HOOK_TIMEOUT_S = 120;
/** Seconds Claude Code waits for the push gate: the project's tests and the reviewer can take minutes. */
const PUSH_HOOK_TIMEOUT_S = 1800;

/** The push gate: same pinned CLI, `hooks push`. */
function pushHookCommand(checker: CheckerCommandSpec): string {
    const args = checker.args[checker.args.length - 1] === 'check' ? [...checker.args.slice(0, -1), 'push'] : [...checker.args, 'push'];
    return pushGateShell(checkerToShellCommand({ command: checker.command, args: [...args, '--stdin'] }));
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

function generateClaudeHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true, brief: boolean = false): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hooks: Record<string, unknown[]> = {
        PostToolUse: [{
            matcher: "Write|Edit|MultiEdit",
            hooks: [{
                type: "command" as const,
                command: `${checkerCommand} --stdin${blockFlag}`,
            }]
        }],
    };

    // Before the agent finishes: review the branch against main (rigour hooks stop).
    hooks.Stop = [{
        hooks: [{ type: "command" as const, command: stopHookCommand(checker, 'claude'), timeout: STOP_HOOK_TIMEOUT_S }],
    }];

    // Before an agent's git push: the branch must pass the review, the project's tools and the reviewer.
    const preToolUse: unknown[] = [{
        matcher: "Bash",
        hooks: [{ type: "command" as const, command: pushHookCommand(checker), timeout: PUSH_HOOK_TIMEOUT_S }],
    }];
    // DLP: credential warnings before any tool runs
    if (dlp) {
        preToolUse.push({
            matcher: ".*",
            hooks: [{
                type: "command" as const,
                command: `${checkerCommand} --mode dlp --stdin`,
            }]
        });
    }
    hooks.PreToolUse = preToolUse;

    // Opt-in: the team's briefing for the task, once per session, from the session's first prompt (rigour hooks brief).
    if (brief) hooks.UserPromptSubmit = [{ hooks: [{ type: "command" as const, command: briefHookCommand(checker), timeout: BRIEF_HOOK_TIMEOUT_S }] }];

    const settings = { hooks };

    return [{
        path: '.claude/settings.json',
        content: JSON.stringify(settings, null, 4),
        description: dlp
            ? 'Claude Code hooks — PostToolUse quality checks, Stop review before done, push gate, PreToolUse DLP credential warnings'
            : 'Claude Code hooks — PostToolUse quality checks, Stop review before done, push gate',
    }];
}

function generateCursorHooks(checker: CheckerCommandSpec, block: boolean, dlp: boolean = true): GeneratedFile[] {
    const blockFlag = block ? ' --block' : '';
    const checkerCommand = checkerToShellCommand(checker);
    const hookEntries: Record<string, unknown[]> = {
        afterFileEdit: [{ command: `${checkerCommand} --stdin${blockFlag}` }],
        stop: [{ command: stopHookCommand(checker, 'cursor'), loop_limit: STOP_MAX_ATTEMPTS }],
    };
    if (dlp) {
        hookEntries.beforeSubmitPrompt = [{ command: `${checkerCommand} --mode dlp --stdin` }];
    }
    const hooks = { version: 1, hooks: hookEntries };

    return [{
        path: '.cursor/hooks.json',
        content: JSON.stringify(hooks, null, 4),
        description: dlp
            ? 'Cursor hooks — afterFileEdit quality checks, stop review before done, beforeSubmitPrompt DLP warnings'
            : 'Cursor hooks — afterFileEdit quality checks, stop review before done',
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
            description: 'Cline PreToolUse DLP hook — credential warnings before agent execution',
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
 * Warns about possible credentials before agent execution.
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
        if (result.status !== 'clean') {
            const msgs = result.detections
                .map(d => \`[rigour/dlp/\${d.type}] \${d.description} → \${d.recommendation}\`)
                .join('\\n');
            const label = result.status === 'blocked' ? 'BLOCKED' : 'warning';
            process.stdout.write(JSON.stringify({
                contextModification: \`\\n⚠️ [Rigour DLP] \${result.detections.length} possible credential(s) \${label}:\\n\${msgs}\`,
            }));
            if (result.status === 'blocked') process.exit(2);
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
            ? 'Windsurf hooks — post_write_code quality checks + pre_write_code DLP warnings'
            : 'Windsurf post_write_code hook config',
    }];
}

const GENERATORS: Record<HookTool, (checker: CheckerCommandSpec, block: boolean, dlp?: boolean, brief?: boolean) => GeneratedFile[]> = {
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

/** `recordRoot`: where the install record lives (the repository, or Rigour's home for a machine install). */
async function writeHookFiles(
    cwd: string, files: GeneratedFile[], force: boolean, recordRoot = cwd
): Promise<{ written: number; skipped: number; failedPaths: Set<string> }> {
    let written = 0;
    let skipped = 0;
    const failedPaths = new Set<string>();

    for (const file of files) {
        const fullPath = path.join(cwd, file.path);
        const exists = await fs.pathExists(fullPath);
        const isConfig = file.path.endsWith('.json');

        // A JSON config the person already has (their permissions, env, own hooks) is merged into,
        // never replaced: Rigour's earlier entries are swapped for the new ones, the rest is kept.
        if (exists && isConfig) {
            try {
                const current = await fs.readFile(fullPath, 'utf-8');
                const next = JSON.stringify(mergeHooksInto(JSON.parse(current), JSON.parse(file.content)), null, 4) + '\n';
                if (next.trimEnd() === current.trimEnd()) continue; // already as it should be: a committed file stays untouched
                await fs.writeFile(fullPath, next, 'utf-8');
                console.log(chalk.green(`  MERGE ${file.path}`));
                console.log(chalk.dim(`         ${file.description} (your other settings kept)`));
                written++;
            } catch (error) {
                console.error(chalk.yellow(`  SKIP ${file.path} (not valid JSON, so Rigour leaves it alone: ${error instanceof Error ? error.message : String(error)})`));
                failedPaths.add(file.path);
            }
            continue;
        }
        // A script of the person's own is never overwritten, --force or not; Rigour's own is refreshed.
        if (exists && (!force || !isRigourScript(await fs.readFile(fullPath, 'utf-8')))) {
            console.log(chalk.yellow(`  SKIP ${file.path} (already exists${force ? ' and is not Rigour\'s' : ', use --force to overwrite'})`));
            skipped++;
            continue;
        }

        try {
            await fs.ensureDir(path.dirname(fullPath));
            // JSON ends with a newline, as the merge above writes it, so a later setup changes nothing.
            const content = isConfig && !file.content.endsWith('\n') ? `${file.content}\n` : file.content;
            await fs.writeFile(fullPath, content, 'utf-8');
            recordCreated(recordRoot, file.path, content);

            if (file.executable) {
                await fs.chmod(fullPath, 0o755);
            }

            console.log(chalk.green(`  CREATE ${file.path}`));
            console.log(chalk.dim(`         ${file.description}`));
            written++;
        } catch (error) {
            const code = error instanceof Error && 'code' in error
                ? String((error as NodeJS.ErrnoException).code)
                : 'UNKNOWN';
            const reason = code === 'ENOTDIR'
                ? 'a parent path is a file; keep the existing config and configure this tool manually'
                : error instanceof Error ? error.message : String(error);
            console.error(chalk.yellow(`  SKIP ${file.path} (${reason})`));
            failedPaths.add(file.path);
        }
    }

    return { written, skipped, failedPaths };
}

// ── Next-steps guidance ──────────────────────────────────────────────

const NEXT_STEPS: Record<HookTool, string> = {
    claude: 'Claude Code: Hooks are active immediately. Rigour runs after every Write/Edit.',
    cursor: 'Cursor: Reload window (Cmd+Shift+P > Reload). Check Output > Hooks panel for logs.',
    cline: 'Cline: Hook is active. Quality feedback appears in agent context on violations.',
    windsurf: 'Windsurf: Reload editor. Check terminal for Rigour output after Cascade writes.',
};

function printNextSteps(tools: HookTool[], unavailableTools: Set<HookTool>): void {
    console.log(chalk.cyan('\nNext steps:'));
    for (const tool of tools) {
        if (unavailableTools.has(tool)) {
            console.log(chalk.yellow(`  ${tool[0].toUpperCase() + tool.slice(1)}: Not configured; resolve the path conflict or configure manually.`));
        } else {
            console.log(chalk.dim(`  ${NEXT_STEPS[tool]}`));
        }
    }
    console.log('');
}

// ── Main command entry point ─────────────────────────────────────────

/**
 * The personal install's agent hooks, once per machine (personal.ts): every agent's user-level
 * config, each command guarded so it runs only in a repository switched on with `rigour setup`.
 * Merged into the person's existing configs like a project install; recorded in Rigour's home.
 */
export async function installMachineHooks(options: { block?: boolean; dlp?: boolean } = {}): Promise<{ agents: HookTool[]; written: number; failed: string[] }> {
    const checker = resolveCheckerCommand();
    const agents = installedAgents();
    const files = agents.flatMap(tool => GENERATORS[tool](checker, options.block !== false, options.dlp !== false)).map(file => asUserLevel(file));
    const { written, failedPaths } = await writeHookFiles(agentHome(), files, true, path.dirname(rigourUserDir()));
    return { agents, written, failed: [...failedPaths] };
}

export async function hooksInitCommand(cwd: string, options: HooksOptions = {}): Promise<void> {
    console.log(chalk.blue('\nRigour Hooks Setup\n'));

    await logStudioEvent(cwd, {
        type: 'tool_call',
        tool: 'rigour_hooks_init',
        arguments: { tool: options.tool, dryRun: options.dryRun, dlp: options.dlp },
    });

    const tools = resolveTools(cwd, options.tool);
    const checker = resolveCheckerCommand();
    const block = !!options.block;
    // DLP is ON by default — user must explicitly pass --no-dlp to disable
    const dlp = options.dlp !== false;

    // Collect generated files — each generator includes DLP hooks in the SAME config file
    const allFiles: GeneratedFile[] = [];
    for (const tool of tools) {
        allFiles.push(...GENERATORS[tool](checker, block, dlp, !!options.brief));
    }

    if (options.dryRun) {
        printDryRun(allFiles);
        return;
    }

    const { written, skipped, failedPaths } = await writeHookFiles(cwd, allFiles, !!options.force);
    const failed = failedPaths.size;
    const unavailableTools = new Set(tools.filter(tool => {
        const generatedPaths = GENERATORS[tool](checker, block, dlp, !!options.brief).map(file => file.path);
        return generatedPaths.every(filePath => failedPaths.has(filePath));
    }));

    console.log('');
    if (written > 0) {
        console.log(chalk.green.bold(`Created ${written} hook file(s).`));
    }
    if (skipped > 0) {
        console.log(chalk.yellow(`Skipped ${skipped} existing file(s).`));
    }
    if (failed > 0) {
        console.log(chalk.yellow(`Skipped ${failed} incompatible hook file(s); other tools were configured.`));
    }

    printNextSteps(tools, unavailableTools);

    if (dlp) {
        console.log(chalk.yellow.bold('  ⚠ DLP warnings ACTIVE'));
        console.log(chalk.dim('  Possible credentials will be reported before agent actions.'));
        console.log(chalk.dim('  Use --block only when every input path is covered by the same policy.'));
        console.log(chalk.dim('  Coverage: AWS keys, API tokens, database URLs, private keys, JWTs, passwords.\n'));
    }

    // Git's own pre-push hook: the same push gate for every tool and for a terminal, not only the agents above.
    const gitHook = installGitPushHook(cwd, pinnedCliCommand());
    if (gitHook.action === 'managed elsewhere') {
        console.log(chalk.yellow(`Git pre-push hooks are managed outside this repository (${gitHook.path}); Rigour leaves that file alone.`));
        console.log(chalk.dim(`  To gate every push there, add: ${pinnedCliCommand()} hooks push --git "$@" || exit $?\n`));
    } else if (gitHook.action !== 'no repository') {
        console.log(chalk.green(`Git pre-push hook ${gitHook.action}: ${gitHook.path}`));
        console.log(chalk.dim('  Every push from any tool or terminal goes through the gate; `rigour hooks selftest` proves it with a real push.\n'));
    }

    await logStudioEvent(cwd, {
        type: 'tool_response',
        tool: 'rigour_hooks_init',
        status: failed > 0 ? 'partial' : 'success',
        content: [{
            type: 'text',
            text: `Generated hooks for: ${tools.join(', ')}; ${written} written, ${skipped} existing, ${failed} incompatible`,
        }],
    });
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
}

export function parseStdinFiles(input: string): string[] {
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
            // Claude Code's PreToolUse hook sees every agent tool call: record it so
            // Studio's context savings are observed, not assumed.
            recordHookPayload(payload, cwd);
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
            block_on_detection: options.block ?? false,
            cwd,
            use_learned_feedback: true,
        });

        const messages = result.detections
            .map((d: any) => `[${d.type}] ${d.description} → ${d.recommendation}`)
            .join('\n');
        const allowCommand = `npx --yes @rigour-labs/cli@${getHookCliVersion()} hooks check --dlp-allow-last`;

        // Return Cursor-compatible format if detected as Cursor hook
        if (cursorMode) {
            if (result.status === 'blocked') {
                process.stdout.write(JSON.stringify({
                    continue: false,
                    user_message: `🛑 Rigour DLP: ${result.detections.length} credential(s) detected in your prompt:\n${messages}\n\nReplace with environment variable references before submitting.\n\nIf this is a false positive, run: ${allowCommand}`,
                }));
            } else if (result.status === 'warning') {
                process.stdout.write(JSON.stringify({
                    continue: true,
                    user_message: `⚠️ Rigour DLP warning: ${result.detections.length} possible credential(s) detected:\n${messages}`,
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

            try {
                await writeDLPBlockManifest(cwd, result.detections, textToScan);
            } catch {
                // best-effort
            }

            if (result.status === 'blocked') {
                process.exitCode = 2;
            }
        }
        return;
    }

    // ── Standard Mode: Check files ───────────────────────────
    const timeout = options.timeout ? Number(options.timeout) : 5000;
    let rawStdin = '';
    let cursorMode = false;

    let hookSession: string | undefined;
    if (options.stdin) {
        rawStdin = await readStdin();
        // Detect Cursor/IDE hook payload format
        try {
            const payload = JSON.parse(rawStdin);
            if (isCursorHookPayload(payload) || typeof payload.new_content === 'string') {
                cursorMode = true;
            }
            // The session's first edit fixes the commit its stop review starts from (hooks-stop.ts).
            const session = payload.session_id || payload.conversation_id;
            if (typeof session === 'string') {
                recordSessionBaseline(cwd, session);
                hookSession = session;
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
        // Nothing was checked: never report pass, or a hook wired to the wrong input looks healthy.
        if (!cursorMode) process.stderr.write('[rigour] hooks check: no file in the hook input, nothing checked\n');
        process.stdout.write(JSON.stringify(cursorMode ? { continue: true } : { status: 'skipped', reason: 'no files', failures: [], duration_ms: 0 }));
        return;
    }

    const agentId = options.agent || process.env.RIGOUR_AGENT_ID;
    const runs = await Promise.all(groupFilesByRepo(cwd, files).map(async (group) => ({
        ...group,
        result: await runHookChecker({ cwd: group.root, files: group.files, timeout_ms: Number.isFinite(timeout) ? timeout : 5000, agentId }),
    })));
    const result = mergeHookResults(runs.map(r => r.result));

    countUsage('hook_check');
    for (const failure of result.failures) countUsage(`hook_finding:${failure.gate}`);
    await Promise.allSettled(runs.flatMap(({ root, files: repoFiles, result: repoResult }) => {
        const requestId = randomUUID();
        const outcome = repoResult.status === 'pass' ? 'success' : repoResult.status === 'fail' ? 'rejected' : 'error';
        return [
            Promise.resolve().then(() => recordAgentWrites(root, repoFiles)), // as the agent left them: a person's later change is a lesson
            Promise.resolve().then(() => appendTaskEvent(root, { kind: 'edit-check', ...(hookSession ? { session: hookSession } : {}), ...(agentId || cursorMode ? { agent: agentId || 'cursor' } : {}), files: repoFiles, findings: repoResult.failures.length, status: repoResult.status })),
            updateAutomaticIndexForFiles(root, repoFiles),
            recordEditCatches(root, repoResult, repoFiles),
            recordInteractionEvidence(root, {
                tool: 'rigour_hooks_check', requestId, phase: 'response', outcome,
                deterministic: repoResult.status === 'pass', agentId,
                files: repoFiles, summary: `${repoResult.failures.length} finding(s)`,
            }),
            logStudioEvent(root, {
                type: 'hook_check', requestId, outcome, status: repoResult.status, agentId,
                files: repoFiles, summary: `${repoFiles.length} file(s), ${repoResult.failures.length} finding(s)`,
                findings: repoResult.failures.slice(0, 10).map(f => ({ gate: f.gate, file: f.file, line: f.line, message: f.message, severity: f.severity })),
            }),
        ];
    }));

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

/** One verdict for a hook call that checked files in several repositories. */
function mergeHookResults(results: HookCheckerResult[]): HookCheckerResult {
    const failures = results.flatMap(r => r.failures);
    const status = results.some(r => r.status === 'error') ? 'error' : failures.length > 0 ? 'fail' : 'pass';
    return { status, failures, duration_ms: Math.max(0, ...results.map(r => r.duration_ms)) };
}
