/**
 * The personal install: nothing in the working tree. Agent hooks live once per machine in each
 * agent's user-level config (`~/.claude/settings.json`, `~/.cursor/hooks.json`,
 * `~/.codeium/windsurf/hooks.json`, `~/Documents/Cline/Hooks/`), and every one starts with a guard
 * that lets it through only in a repository someone switched on with `rigour setup`. Switching a
 * repository on writes only inside its git directory, which is never committed: a marker, the
 * pre-push hook, and `.rigour/` in `info/exclude` rather than `.gitignore`. A repository nobody
 * switched on (another employer's, a client's) is never checked, and pays only a `test -f`.
 *
 * A team that wants Rigour for everyone who clones uses `rigour setup --team` instead, which
 * commits its configuration to the repository.
 */
import { spawnSync } from 'child_process';
import { execaSync } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rigourUserDir } from '@rigour-labs/core';
import { isEmptyConfig, isRigourMcpEntry, readInstallRecord, recordCreated, unchangedSinceInstall, withoutRigour } from './install-record.js';

const MARKER = 'rigour-enabled';

/**
 * Where the agents keep their user-level configs: RIGOUR_AGENT_HOME when set (tests, a sandbox),
 * else the OS home. Read from the environment Rigour sees, not os.homedir() alone, which ignores a
 * changed HOME inside worker threads: every write to an agent's home goes through this.
 */
export function agentHome(): string {
    return process.env.RIGOUR_AGENT_HOME || os.homedir();
}

/** The Claude Code CLI Rigour asks to register its MCP server (RIGOUR_CLAUDE_CLI overrides it). */
function claudeCli(): string {
    return process.env.RIGOUR_CLAUDE_CLI || 'claude';
}

/**
 * Runs the Claude Code CLI. Through execa (cross-spawn), so Windows finds and runs its `claude.cmd` shim: a bare spawn
 * neither looks one up nor may run a .cmd without a shell, and every Windows install reported "no CLI".
 */
function claude(args: string[]): { ok: boolean; stdout: string } {
    const run = execaSync(claudeCli(), args, { reject: false });
    return { ok: !run.failed && run.exitCode === 0, stdout: String(run.stdout ?? '') };
}
const EXCLUDE_LINE = '.rigour/';

/** The repository's shared git directory (the same for every worktree), or undefined outside one. */
function gitCommonDir(cwd: string): string | undefined {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Whether Rigour is switched on for this repository by a personal install. */
export function enabledHere(cwd: string): boolean {
    const common = gitCommonDir(cwd);
    return !!common && fs.existsSync(path.join(common, MARKER));
}

/** Switches Rigour on here: the marker and the exclude line, both inside the git directory. */
export function enableHere(cwd: string): boolean {
    const common = gitCommonDir(cwd);
    if (!common) return false;
    fs.writeFileSync(path.join(common, MARKER), 'Rigour is on for this repository (rigour setup). `rigour uninstall` switches it off.\n');
    const exclude = path.join(common, 'info', 'exclude');
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!text.split('\n').some(line => line.trim() === EXCLUDE_LINE)) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
    }
    return true;
}

/** Switches Rigour off here: the marker goes; the exclude line goes with `.rigour/` itself (`withState`). */
export function disableHere(cwd: string, withState: boolean): string[] {
    const common = gitCommonDir(cwd);
    if (!common) return [];
    const changes: string[] = [];
    const marker = path.join(common, MARKER);
    if (fs.existsSync(marker)) {
        fs.unlinkSync(marker);
        changes.push('switch Rigour off for this repository');
    }
    const exclude = path.join(common, 'info', 'exclude');
    if (withState && fs.existsSync(exclude)) {
        const lines = fs.readFileSync(exclude, 'utf8').split('\n');
        const kept = lines.filter(line => line.trim() !== EXCLUDE_LINE);
        if (kept.length !== lines.length) {
            fs.writeFileSync(exclude, kept.join('\n'));
            changes.push('remove .rigour/ from .git/info/exclude');
        }
    }
    return changes;
}

/**
 * A hook command that runs only where Rigour is switched on. Claude Code gives hooks the project in
 * CLAUDE_PROJECT_DIR; the other agents run them in the workspace. Outside a repository, or in one
 * nobody switched on, it exits 0 before anything starts.
 */
function guardCommand(command: string): string {
    const inner = `cd "\${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null; d=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0; [ -f "$d/${MARKER}" ] || exit 0; exec ${command}`;
    return `sh -c '${inner.replace(/'/g, `'\\''`)}'`;
}

/** The same guard for a Node hook script (Cline's): it answers `{}` and stops where Rigour is off. */
function guardScript(script: string): string {
    const guard = `// Rigour personal install: run only in a repository \`rigour setup\` switched on.
{
    const found = require('child_process').spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    const dir = found.status === 0 ? require('path').resolve(found.stdout.trim()) : '';
    if (!dir || !require('fs').existsSync(require('path').join(dir, '${MARKER}'))) { process.stdout.write('{}'); process.exit(0); }
}
`;
    const shebang = script.startsWith('#!') ? script.slice(0, script.indexOf('\n') + 1) : '';
    return `${shebang}${guard}${script.slice(shebang.length)}`;
}

/** Where each agent reads user-level hooks, relative to the home directory, for the project path Rigour writes. */
const USER_LEVEL_PATH: Record<string, string> = {
    '.claude/settings.json': '.claude/settings.json',
    '.cursor/hooks.json': '.cursor/hooks.json',
    '.windsurf/hooks.json': '.codeium/windsurf/hooks.json',
    '.clinerules/hooks/PostToolUse': 'Documents/Cline/Hooks/PostToolUse',
    '.clinerules/hooks/PreToolUse': 'Documents/Cline/Hooks/PreToolUse',
};

/** Where each agent keeps its settings at user level: an agent with no such folder is not installed here. */
const AGENT_HOME_DIR = { claude: '.claude', cursor: '.cursor', windsurf: '.codeium/windsurf', cline: 'Documents/Cline' } as const;

/** The agents installed on this machine, Claude Code when none is: the only ones whose user-level config Rigour writes. */
export function installedAgents(): Array<keyof typeof AGENT_HOME_DIR> {
    const found = (Object.keys(AGENT_HOME_DIR) as Array<keyof typeof AGENT_HOME_DIR>).filter(agent => fs.existsSync(path.join(agentHome(), AGENT_HOME_DIR[agent])));
    return found.length ? found : ['claude'];
}

/** A project hook file as its user-level twin: the agent's home path, every command guarded. */
export function asUserLevel<T extends { path: string; content: string }>(file: T): T {
    const target = USER_LEVEL_PATH[file.path];
    if (!target) throw new Error(`no user-level location for ${file.path}`);
    if (!file.path.endsWith('.json')) return { ...file, path: target, content: guardScript(file.content) };
    const guard = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(guard);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'command' && typeof child === 'string' ? guardCommand(child) : guard(child)]));
    };
    return { ...file, path: target, content: JSON.stringify(guard(JSON.parse(file.content)), null, 4) };
}

export type McpState = 'added' | 'updated' | 'present' | 'removed' | 'absent' | 'no CLI';

/**
 * The Rigour MCP server at user level: Claude Code through its own `claude mcp add --scope user`
 * (its state file is Claude's, not Rigour's to edit), Cursor merged into `~/.cursor/mcp.json`.
 */
export function registerUserMcp(server: { command: string; args: string[] }): { claude: McpState; cursor: McpState } {
    let state: McpState = 'no CLI';
    if (claude(['--version']).ok) {
        const add = () => claude(['mcp', 'add', '--scope', 'user', 'rigour', '--', server.command, ...server.args]).ok;
        const get = claude(['mcp', 'get', 'rigour']);
        if (!get.ok) state = add() ? 'added' : 'no CLI';
        // Rigour's own registration at another version is moved to this one, as the hooks are; one the person changed stays.
        else if (/@rigour-labs\/mcp/.test(get.stdout) && !get.stdout.includes(server.args[server.args.length - 1])) {
            claude(['mcp', 'remove', '--scope', 'user', 'rigour']);
            state = add() ? 'updated' : 'no CLI';
        } else state = 'present';
    }
    if (!installedAgents().includes('cursor')) return { claude: state, cursor: 'absent' };
    const cursorFile = path.join(agentHome(), '.cursor', 'mcp.json');
    let config: any = {};
    const existed = fs.existsSync(cursorFile);
    if (existed) {
        try {
            config = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
        } catch {
            return { claude: state, cursor: 'absent' }; // not valid JSON: the person's to fix, not Rigour's to replace
        }
    }
    const current = config?.mcpServers?.rigour;
    if (current && (JSON.stringify(current) === JSON.stringify(server) || !isRigourMcpEntry(current))) return { claude: state, cursor: 'present' };
    config.mcpServers = { ...(config.mcpServers ?? {}), rigour: server };
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    const content = JSON.stringify(config, null, 4) + '\n';
    fs.writeFileSync(cursorFile, content);
    if (!existed) recordCreated(path.dirname(rigourUserDir()), path.relative(agentHome(), cursorFile), content);
    return { claude: state, cursor: current ? 'updated' : 'added' };
}

/**
 * `rigour uninstall --machine`: the user-level hooks and MCP server out of every agent's config
 * (the person's other settings stay; a file Rigour created and left empty goes), Rigour's own
 * Cline hook scripts, and the shared semantic search runtime.
 */
export function uninstallMachine(dryRun: boolean): string[] {
    const changes: string[] = [];
    const act = (change: string, run: () => void) => {
        if (!dryRun) run();
        changes.push(change);
    };
    const home = agentHome();
    const record = readInstallRecord(path.dirname(rigourUserDir()));
    const configs = [...Object.values(USER_LEVEL_PATH).filter(p => p.endsWith('.json')), path.join('.cursor', 'mcp.json')];
    for (const rel of configs) {
        const file = path.join(home, rel);
        if (!fs.existsSync(file)) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            continue;
        }
        const stripped = withoutRigour(parsed);
        if (JSON.stringify(stripped) === JSON.stringify(parsed)) continue;
        const recordKey = rel.split(path.sep).join('/');
        if (isEmptyConfig(stripped) && recordKey in record.created) act(`delete ~/${recordKey}`, () => fs.unlinkSync(file));
        else act(`remove Rigour entries from ~/${recordKey}`, () => fs.writeFileSync(file, JSON.stringify(stripped, null, 4) + '\n'));
    }
    for (const rel of Object.values(USER_LEVEL_PATH).filter(p => !p.endsWith('.json'))) {
        const file = path.join(home, rel);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (unchangedSinceInstall(record, rel, text) || /hook for Rigour/.test(text)) act(`delete ~/${rel}`, () => fs.unlinkSync(file));
    }
    if (claude(['mcp', 'get', 'rigour']).ok) {
        act('remove the Rigour MCP server from Claude Code (user scope)', () => claude(['mcp', 'remove', '--scope', 'user', 'rigour']));
    }
    const runtime = path.join(rigourUserDir(), 'runtime');
    if (fs.existsSync(runtime)) act('delete the shared semantic search runtime', () => fs.rmSync(runtime, { recursive: true, force: true }));
    return changes;
}
