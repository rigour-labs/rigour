/**
 * Is Rigour wired up in this repository, and is it actually running? Shared by `rigour doctor`
 * and Studio's Setup page. "working" means Rigour saw it fire in the last week, not only that a
 * config file exists; "broken" means it is configured in a way that cannot work.
 */
import fs from 'fs';
import path from 'path';
import { readAgentEvents, type AgentEvent } from '@rigour-labs/core';

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

export function checkRepoSetup(cwd: string, now = new Date()): SetupCheck[] {
    const events = readAgentEvents(cwd);
    const read = (rel: string) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
    const claude = read('.claude/settings.json') + read('.claude/settings.local.json');
    const cursor = read('.cursor/hooks.json');
    return [
        configCheck(cwd),
        hookCheck('claude-edit', 'Checks Claude Code as it writes', claude, now, events),
        ...(cursor ? [hookCheck('cursor-edit', 'Checks Cursor as it writes', cursor, now, events)] : []),
        stopCheck(claude + cursor, now, events),
        mcpCheck(read('.mcp.json'), now, events),
        prCheck(cwd),
    ];
}

function configCheck(cwd: string): SetupCheck {
    return fs.existsSync(path.join(cwd, 'rigour.yml'))
        ? { id: 'config', name: 'Project settings', state: 'working', detail: 'rigour.yml' }
        : { id: 'config', name: 'Project settings', state: 'missing', detail: 'No rigour.yml: Rigour uses its defaults', fix: 'rigour setup' };
}

function hookCheck(id: string, name: string, config: string, now: Date, events: AgentEvent[]): SetupCheck {
    if (!config.includes('hooks check')) return { id, name, state: 'missing', detail: 'No edit hook configured', fix: 'rigour setup' };
    if (config.includes('TOOL_INPUT_file_path')) {
        return { id, name, state: 'broken', detail: 'The hook reads a variable the agent never sets, so it checks nothing', fix: 'rigour hooks init --force' };
    }
    return fired(id, name, events.filter(e => e.type === 'hook_check'), now, 'edit checks');
}

function stopCheck(config: string, now: Date, events: AgentEvent[]): SetupCheck {
    const name = 'Stops an agent finishing with a known bug';
    if (!config.includes('hooks stop')) return { id: 'stop', name, state: 'missing', detail: 'No stop hook configured', fix: 'rigour hooks init --force' };
    return fired('stop', name, events.filter(e => e.type === 'stop_review'), now, 'finish checks');
}

function mcpCheck(mcpJson: string, now: Date, events: AgentEvent[]): SetupCheck {
    const name = 'Rigour tools for agents (MCP)';
    const calls = events.filter(e => e.type === 'tool_call');
    if (!mcpJson.includes('rigour') && calls.length === 0) {
        return { id: 'mcp', name, state: 'missing', detail: 'Agents cannot ask Rigour for review tasks or lessons', fix: 'rigour setup' };
    }
    return fired('mcp', name, calls, now, 'tool calls');
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
