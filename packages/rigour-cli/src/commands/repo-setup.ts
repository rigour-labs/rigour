/**
 * Is Rigour wired up in this repository, and is it actually running? Shared by `rigour doctor`
 * and Studio's Setup page. "working" means Rigour saw it fire in the last week, not only that a
 * config file exists; "broken" means it is configured in a way that cannot work.
 */
import fs from 'fs';
import path from 'path';
import { getContextEvents, type AgentEvent, type ContextEvent } from '@rigour-labs/core';
import { resolveMCPServerConfig } from './init.js';
import { agentHome, enabledHere, MCP_NAME_TAKEN } from './personal.js';
import { namesRigourMcp } from './install-record.js';
import { isOldEditHook } from './setup-migrations.js';
import { getCliVersion } from '../utils/cli-version.js';
import { gatePins, pushHookTarget } from './hooks-git.js';
import { checkoutRoots, eventsAcross } from './studio-checkouts.js';
import { liveWindsurfHooks, rigourHooksIgnored, WINDSURF_HOOKS } from './windsurf-hooks.js';

export type SetupState = 'working' | 'set up' | 'broken' | 'missing';

export interface SetupCheck {
    id: string;
    name: string;
    state: SetupState;
    detail: string;
    /** What to run when it is not working. */
    fix?: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const readFrom = (base: string) => (rel: string) => { try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch { return ''; } };

export async function checkRepoSetup(cwd: string, now = new Date(), toolCalls?: ContextEvent[], installed = getCliVersion()): Promise<SetupCheck[]> {
    const events = eventsAcross(checkoutRoots(cwd));
    // Only the MCP server writes context records, one per tool call: the CLI's own events would count otherwise.
    const calls = toolCalls ?? await getContextEvents(undefined, cwd).catch(() => []);
    const read = readFrom(cwd);
    // A personal install keeps its hooks and MCP server at user level, switched on per repository (personal.ts).
    const personal = enabledHere(cwd);
    const home = personal ? readFrom(agentHome()) : () => '';
    const windsurfFile = liveWindsurfHooks(read);
    const agents = agentHookConfigs(cwd);
    const mcpConfig = read('.mcp.json') + read('.cursor/mcp.json') + home('.claude.json') + home('.cursor/mcp.json');
    // The repository's own committed install: only `rigour setup --team` changes it (a plain setup leaves it as committed).
    const setup = !personal && /rigour/i.test(agents.map(a => a.config).join('\n')) ? 'rigour setup --team' : 'rigour setup';
    const version = versionCheck(agents.map(a => a.config).join('\n'), mcpConfig, installed, setup, pushGateIn(cwd, personal));
    return [
        configCheck(cwd, personal),
        editCheck(agents, now, events, setup),
        stopCheck(agents.map(a => a.config).join('\n'), now, events, setup),
        mcpCheck(mcpConfig, now, calls, nameTaken(readFrom(agentHome()))),
        ...(version ? [version] : []),
        ...(rigourHooksIgnored(read) ? [windsurfFileCheck(windsurfFile, setup)] : []),
        prCheck(cwd),
    ];
}

/**
 * Each agent with Rigour-capable hooks that has a hook config here (the project's, or the machine's for a personal
 * install), and that config's text: what setup and Studio's coverage read to say which hooks an agent runs.
 */
export function agentHookConfigs(cwd: string): Array<{ name: string; config: string }> {
    const read = readFrom(cwd);
    const home = enabledHere(cwd) ? readFrom(agentHome()) : () => '';
    // Devin Desktop (formerly Windsurf) reads one project file: the agent's config is that one, named in the check.
    const windsurfFile = liveWindsurfHooks(read);
    return [
        { name: 'Claude Code', config: read('.claude/settings.json') + read('.claude/settings.local.json') + home('.claude/settings.json') },
        { name: 'Cursor', config: read('.cursor/hooks.json') + home('.cursor/hooks.json') },
        { name: `Windsurf (${windsurfFile})`, config: read(windsurfFile) + home('.codeium/windsurf/hooks.json') },
        { name: 'Cline', config: ['PostToolUse', 'PreToolUse'].map(hook => read(`.clinerules/hooks/${hook}`) + home(`Documents/Cline/Hooks/${hook}`)).join('') },
    ].filter(a => a.config);
}

/**
 * Whether the agent hooks and the MCP server run the Rigour that is installed. Each pins a version
 * (`@rigour-labs/cli@6.12.4`), so an upgrade reaches them only when `rigour setup` rewrites the pin.
 * Nothing to say when nothing pins a version (a source checkout runs its own build).
 */
function versionCheck(hooks: string, mcp: string, installed: string, setup: string, gate?: PushGatePin): SetupCheck | undefined {
    const pins = (text: string, pkg: string) => [...new Set([...text.matchAll(new RegExp(`@rigour-labs/${pkg}@([0-9A-Za-z.-]+)`, 'g'))].map(m => m[1]))];
    const hookPins = pins(hooks, 'cli');
    const mcpPins = pins(mcp, 'mcp');
    // Before 6.13.0 a personal install's guard and the push gate were `sh -c '…'` wrappers: PowerShell cannot run them.
    const wrapped = /sh -c '[^\n]*@rigour-labs\/cli@/.test(hooks);
    const staleGate = gate?.pins.find(pin => pin.version !== installed);
    if (!hookPins.length && !mcpPins.length && !gate?.pins.length) return undefined;
    const name = 'Agent hooks and tools run the installed Rigour';
    const stale = [
        ...(wrapped ? ['hooks run through a shell wrapper PowerShell cannot run'] : []),
        ...hookPins.filter(v => v !== installed).map(v => `hooks run ${v}`),
        ...mcpPins.filter(v => v !== installed).map(v => (/^\d+$/.test(v) || v === 'latest' ? `the MCP server floats on @${v}` : `the MCP server runs ${v}`)),
        ...(staleGate ? [`the push gate in ${gate!.file} runs ${staleGate.version}`] : []),
    ];
    // A tracked script is rewritten only by a team setup; a personal install never writes it, so its fix is the line to paste.
    const others = stale.length > (staleGate ? 1 : 0);
    const paste = staleGate && `in ${gate!.file} replace Rigour's line with: ${staleGate.line.replace(/@rigour-labs\/cli@[0-9A-Za-z.-]+/, `@rigour-labs/cli@${installed}`)}`;
    const fix = !staleGate || !gate!.tracked ? setup : gate!.personal ? (others ? `${setup}, then ${paste}` : paste!) : 'rigour setup --team';
    return stale.length
        ? { id: 'version', name, state: 'broken', detail: `${stale.join(', ')}; installed is ${installed}`, fix }
        : { id: 'version', name, state: 'working', detail: installed };
}

interface PushGatePin { file: string; pins: Array<{ version: string; line: string }>; tracked: boolean; personal: boolean }

/**
 * Rigour's push-gate line wherever git runs it (a husky script, an in-tree hooksPath script, .git/hooks), and the
 * versions it pins. `tracked`: a script in the working tree, which only `rigour setup --team` rewrites.
 */
function pushGateIn(cwd: string, personal: boolean): PushGatePin | undefined {
    const target = pushHookTarget(cwd);
    if (!target || target.managed === 'outside') return undefined;
    let text = '';
    try { text = fs.readFileSync(target.file, 'utf8'); } catch { return undefined; }
    const top = path.relative(cwd, target.file);
    return { file: top && !top.startsWith('..') ? top : target.file, pins: gatePins(text), tracked: !!target.managed, personal };
}

/** Rigour's Windsurf hooks are only in the legacy file, which Devin Desktop ignores while `.devin/hooks.json` defines hooks. */
function windsurfFileCheck(live: string, setup: string): SetupCheck {
    return {
        id: 'windsurf-file', name: 'Windsurf hooks are in the file Devin Desktop reads', state: 'broken',
        detail: `Rigour's hooks are only in ${WINDSURF_HOOKS}; Devin Desktop reads ${live} and ignores ${WINDSURF_HOOKS}, so no Cascade write is checked`,
        fix: setup,
    };
}

function configCheck(cwd: string, personal: boolean): SetupCheck {
    if (fs.existsSync(path.join(cwd, 'rigour.yml'))) return { id: 'config', name: 'Project settings', state: 'working', detail: 'rigour.yml' };
    return personal
        ? { id: 'config', name: 'Project settings', state: 'working', detail: 'Personal install: Rigour\'s defaults, switched on for this repository (nothing committed)' }
        : { id: 'config', name: 'Project settings', state: 'missing', detail: 'No rigour.yml: Rigour uses its defaults', fix: 'rigour setup' };
}

/** One check for every agent's edit hook: events do not say which agent fired them, so counts are not split. */
function editCheck(agents: Array<{ name: string; config: string }>, now: Date, events: AgentEvent[], setup: string): SetupCheck {
    const wired = agents.filter(a => a.config.includes('hooks check'));
    const name = wired.length ? `Checks ${listOf(wired.map(a => a.name))} as it writes` : 'Checks your agent as it writes';
    if (wired.length === 0) return { id: 'edit', name, state: 'missing', detail: 'No edit hook configured', fix: setup };
    const broken = wired.find(a => isOldEditHook(a.config));
    if (broken) {
        // setup rewrites Rigour's own entries where they live (the project, or the machine for a personal install).
        return { id: 'edit', name, state: 'broken', detail: `The ${broken.name} hook is the old form: it reads a variable the agent never sets, so no edit is checked`, fix: setup };
    }
    return fired('edit', name, events.filter(e => e.type === 'hook_check'), now, 'edit checks');
}

function stopCheck(config: string, now: Date, events: AgentEvent[], setup: string): SetupCheck {
    const name = 'Stops an agent finishing with a known bug';
    if (!config.includes('hooks stop')) return { id: 'stop', name, state: 'missing', detail: 'No stop hook configured', fix: setup };
    return fired('stop', name, events.filter(e => e.type === 'stop_review'), now, 'finish checks');
}

/** Which agent's user-level config holds a server named rigour that is not Rigour's (personal.ts MCP_NAME_TAKEN). */
function nameTaken(home: (rel: string) => string): string[] {
    // Every agent whose server holds the name, in one run: fixing one should not reveal the next on the run after.
    return (([['Claude Code', '.claude.json'], ['Cursor', '.cursor/mcp.json']] as const)).filter(([, rel]) => {
        try {
            const entry = JSON.parse(home(rel) || '{}')?.mcpServers?.rigour;
            return !!entry && !namesRigourMcp(entry);
        } catch {
            return false; // not JSON: not Rigour's to judge
        }
    }).map(([agent]) => agent);
}

function mcpCheck(mcpJson: string, now: Date, calls: ContextEvent[], taken: string[] = []): SetupCheck {
    const name = 'Rigour tools for agents (MCP)';
    if (taken.length) return { id: 'mcp', name, state: 'broken', detail: `${listOf(taken)}: ${MCP_NAME_TAKEN}`, fix: 'rename the other server, then rigour setup' };
    if (!mcpJson.includes('rigour') && calls.length === 0) {
        return { id: 'mcp', name, state: 'missing', detail: 'Agents cannot ask Rigour for review tasks or lessons', fix: `claude mcp add --scope user rigour -- ${[resolveMCPServerConfig().command, ...resolveMCPServerConfig().args].join(' ')}` };
    }
    const asEvents = calls.map(c => ({ type: 'tool_call', timestamp: c.createdAt ? new Date(c.createdAt).toISOString() : undefined }));
    return fired('mcp', name, asEvents, now, 'tool calls');
}

function prCheck(cwd: string): SetupCheck {
    const name = 'Reviews pull requests';
    const dir = path.join(cwd, '.github', 'workflows');
    let workflows: string[] = [];
    try { workflows = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)); } catch { /* no workflows */ }
    const uses = workflows.find(f => /rigour-labs\/rigour@|rigour review|rigour-labs\/cli/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    return uses
        ? { id: 'pr', name, state: 'set up', detail: `.github/workflows/${uses}` }
        : { id: 'pr', name, state: 'missing', detail: 'Not on this repository yet: one workflow file adds it', fix: 'See docs/CI.md' };
}

/** Configured; "working" when it fired in the last week, with how often and how recently. */
function fired(id: string, name: string, seen: AgentEvent[], now: Date, what: string): SetupCheck {
    const recent = seen.filter(e => e.timestamp && now.getTime() - Date.parse(e.timestamp) <= WEEK_MS);
    const last = seen.map(e => e.timestamp ?? '').sort().pop();
    if (recent.length === 0) {
        return { id, name, state: 'set up', detail: last ? `Configured; last fired ${ago(last, now)}` : 'Configured; has not fired here yet' };
    }
    const noun = recent.length === 1 ? what.replace(/s$/, '') : what;
    return { id, name, state: 'working', detail: `${recent.length} ${noun} this week · last ${ago(last!, now)}` };
}

function ago(at: string, now: Date): string {
    const minutes = Math.round((now.getTime() - Date.parse(at)) / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function listOf(names: string[]): string {
    return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
