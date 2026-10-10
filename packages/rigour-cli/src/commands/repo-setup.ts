/**
 * Is Rigour wired up in this repository, and is it actually running? Shared by `rigour doctor`
 * and Studio's Setup page. "working" means Rigour saw it fire in the last week, not only that a
 * config file exists; "broken" means it is configured in a way that cannot work.
 */
import fs from 'fs';
import path from 'path';
import { getContextEvents, type AgentEvent, type ContextEvent } from '@rigour-labs/core';
import { resolveMCPServerConfig } from './init.js';
import { agentHome, enabledHere } from './personal.js';
import { isOldEditHook } from './setup-migrations.js';
import { getCliVersion } from '../utils/cli-version.js';
import { checkoutRoots, eventsAcross } from './studio-checkouts.js';

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

export async function checkRepoSetup(cwd: string, now = new Date(), toolCalls?: ContextEvent[], installed = getCliVersion()): Promise<SetupCheck[]> {
    const events = eventsAcross(checkoutRoots(cwd));
    // Only the MCP server writes context records, one per tool call: the CLI's own events would count otherwise.
    const calls = toolCalls ?? await getContextEvents(undefined, cwd).catch(() => []);
    const readFrom = (base: string) => (rel: string) => { try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch { return ''; } };
    const read = readFrom(cwd);
    // A personal install keeps its hooks and MCP server at user level, switched on per repository (personal.ts).
    const personal = enabledHere(cwd);
    const home = personal ? readFrom(agentHome()) : () => '';
    const agents = [
        { name: 'Claude Code', config: read('.claude/settings.json') + read('.claude/settings.local.json') + home('.claude/settings.json') },
        { name: 'Cursor', config: read('.cursor/hooks.json') + home('.cursor/hooks.json') },
        { name: 'Windsurf', config: read('.windsurf/hooks.json') + home('.codeium/windsurf/hooks.json') },
    ].filter(a => a.config);
    const mcpConfig = read('.mcp.json') + read('.cursor/mcp.json') + home('.claude.json') + home('.cursor/mcp.json');
    const version = versionCheck(agents.map(a => a.config).join('\n'), mcpConfig, installed);
    return [
        configCheck(cwd, personal),
        editCheck(agents, now, events),
        stopCheck(agents.map(a => a.config).join('\n'), now, events),
        mcpCheck(mcpConfig, now, calls),
        ...(version ? [version] : []),
        prCheck(cwd),
    ];
}

/**
 * Whether the agent hooks and the MCP server run the Rigour that is installed. Each pins a version
 * (`@rigour-labs/cli@6.12.4`), so an upgrade reaches them only when `rigour setup` rewrites the pin.
 * Nothing to say when nothing pins a version (a source checkout runs its own build).
 */
function versionCheck(hooks: string, mcp: string, installed: string): SetupCheck | undefined {
    const pins = (text: string, pkg: string) => [...new Set([...text.matchAll(new RegExp(`@rigour-labs/${pkg}@([0-9A-Za-z.-]+)`, 'g'))].map(m => m[1]))];
    const hookPins = pins(hooks, 'cli');
    const mcpPins = pins(mcp, 'mcp');
    // Before 6.13.0 a personal install's guard and the push gate were `sh -c '…'` wrappers: PowerShell cannot run them.
    const wrapped = /sh -c '[^\n]*@rigour-labs\/cli@/.test(hooks);
    if (!hookPins.length && !mcpPins.length) return undefined;
    const name = 'Agent hooks and tools run the installed Rigour';
    const stale = [
        ...(wrapped ? ['hooks run through a shell wrapper PowerShell cannot run'] : []),
        ...hookPins.filter(v => v !== installed).map(v => `hooks run ${v}`),
        ...mcpPins.filter(v => v !== installed).map(v => (/^\d+$/.test(v) || v === 'latest' ? `the MCP server floats on @${v}` : `the MCP server runs ${v}`)),
    ];
    return stale.length
        ? { id: 'version', name, state: 'broken', detail: `${stale.join(', ')}; installed is ${installed}`, fix: 'rigour setup' }
        : { id: 'version', name, state: 'working', detail: installed };
}

function configCheck(cwd: string, personal: boolean): SetupCheck {
    if (fs.existsSync(path.join(cwd, 'rigour.yml'))) return { id: 'config', name: 'Project settings', state: 'working', detail: 'rigour.yml' };
    return personal
        ? { id: 'config', name: 'Project settings', state: 'working', detail: 'Personal install: Rigour\'s defaults, switched on for this repository (nothing committed)' }
        : { id: 'config', name: 'Project settings', state: 'missing', detail: 'No rigour.yml: Rigour uses its defaults', fix: 'rigour setup' };
}

/** One check for every agent's edit hook: events do not say which agent fired them, so counts are not split. */
function editCheck(agents: Array<{ name: string; config: string }>, now: Date, events: AgentEvent[]): SetupCheck {
    const wired = agents.filter(a => a.config.includes('hooks check'));
    const name = wired.length ? `Checks ${listOf(wired.map(a => a.name))} as it writes` : 'Checks your agent as it writes';
    if (wired.length === 0) return { id: 'edit', name, state: 'missing', detail: 'No edit hook configured', fix: 'rigour setup' };
    const broken = wired.find(a => isOldEditHook(a.config));
    if (broken) {
        // setup rewrites Rigour's own entries where they live (the project, or the machine for a personal install).
        return { id: 'edit', name, state: 'broken', detail: `The ${broken.name} hook is the old form: it reads a variable the agent never sets, so no edit is checked`, fix: 'rigour setup' };
    }
    return fired('edit', name, events.filter(e => e.type === 'hook_check'), now, 'edit checks');
}

function stopCheck(config: string, now: Date, events: AgentEvent[]): SetupCheck {
    const name = 'Stops an agent finishing with a known bug';
    if (!config.includes('hooks stop')) return { id: 'stop', name, state: 'missing', detail: 'No stop hook configured', fix: 'rigour setup' };
    return fired('stop', name, events.filter(e => e.type === 'stop_review'), now, 'finish checks');
}

function mcpCheck(mcpJson: string, now: Date, calls: ContextEvent[]): SetupCheck {
    const name = 'Rigour tools for agents (MCP)';
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
        : { id: 'pr', name, state: 'missing', detail: 'Not on this repository yet: one workflow file adds it', fix: 'See docs/PR_BOT.md' };
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
