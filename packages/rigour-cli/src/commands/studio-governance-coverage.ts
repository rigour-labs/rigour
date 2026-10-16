/**
 * Governance coverage: for each agent here, which of Rigour's five moments it runs (the brief, the check on each
 * edit, the review before it says done, the push gate, the pull-request reviewer) and when Rigour last saw each fire.
 * "Configured" is what setup reads from the agents' hook configs; "seen" is what the threads and the event log
 * recorded. A moment fired by an agent Rigour does not name is shown under "agent not recorded", never guessed.
 */
import type { AgentEvent, ThreadEvent } from '@rigour-labs/core';
import { isOldEditHook } from './setup-migrations.js';

const STAGES = ['brief', 'edit', 'stop', 'push', 'pr'] as const;
export type Stage = typeof STAGES[number];
/** `not checked`: setup does not read it (the brief hook); `no hooks`: the agent has no hooks Rigour can use. */
export type Configured = 'on' | 'off' | 'broken' | 'not checked' | 'no hooks';

export interface CoverageCell { configured: Configured | null; seen: string | null }
export interface CoverageRow { agent: string; cells: Record<Stage, CoverageCell>; note?: string }

export interface Coverage {
    stages: Stage[];
    rows: CoverageRow[];
    /** When each moment last fired without an agent on the record (the push gate and the reviewer never record one). */
    unattributed: Record<Stage, string | null>;
    /** Moments switched on, of every moment setup can check, over the agents here. */
    covered: number;
    possible: number;
}

export interface CoverageInputs {
    now: Date;
    agents: Array<{ name: string; config: string }>;
    /** Codex is here (an AGENTS.md or a .codex folder): it has no hooks, so only the push gate and the reviewer reach it. */
    codex: boolean;
    pushGate: boolean;
    prReviewer: boolean;
    threads: ThreadEvent[];
    events: AgentEvent[];
}

const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
/** What an agent is called in a hook's record, and the name setup gives it. */
const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', windsurf: 'Windsurf', cascade: 'Windsurf', devin: 'Windsurf', cline: 'Cline' };
/** The brief's `agent` can name the way it was asked for, not an agent. */
const NOT_AGENTS = new Set(['cli', 'mcp', 'person']);

interface Sighting { stage: Stage; agent: string | undefined; at: string }

export function buildCoverage(input: CoverageInputs): Coverage {
    const recent = sightings(input).filter(s => input.now.getTime() - Date.parse(s.at) <= WINDOW_MS);
    const last = (stage: Stage, agent?: string) => recent.filter(s => s.stage === stage && s.agent === agent).map(s => s.at).sort().pop() ?? null;
    const repoWide = (on: boolean): Configured => (on ? 'on' : 'off');
    const rows: CoverageRow[] = input.agents.map(a => {
        const id = agentId(a.name);
        const hook = (word: string): Configured => (a.config.includes(`hooks ${word}`) ? (word === 'check' && isOldEditHook(a.config) ? 'broken' : 'on') : 'off');
        return { agent: a.name, cells: {
            brief: { configured: 'not checked', seen: last('brief', id) },
            edit: { configured: hook('check'), seen: last('edit', id) },
            stop: { configured: hook('stop'), seen: last('stop', id) },
            push: { configured: repoWide(input.pushGate), seen: null },
            pr: { configured: repoWide(input.prReviewer), seen: null },
        } };
    });
    if (input.codex || recent.some(s => s.agent === 'Codex')) rows.push(codexRow(input, last));
    rows.push(...otherAgents(recent, rows, input, last));
    const checkable = rows.flatMap(r => STAGES.map(s => r.cells[s].configured)).filter(c => c !== null && c !== 'not checked');
    return {
        stages: [...STAGES],
        rows,
        unattributed: Object.fromEntries(STAGES.map(s => [s, last(s)])) as Record<Stage, string | null>,
        covered: checkable.filter(c => c === 'on').length,
        possible: checkable.length,
    };
}

function codexRow(input: CoverageInputs, last: (stage: Stage, agent?: string) => string | null): CoverageRow {
    const none = (stage: Stage): CoverageCell => ({ configured: 'no hooks', seen: last(stage, 'Codex') });
    return {
        agent: 'Codex',
        note: 'No hooks: Rigour cannot check its edits or stop it. The push gate and the reviewer still reach it.',
        cells: { brief: none('brief'), edit: none('edit'), stop: none('stop'), push: { configured: input.pushGate ? 'on' : 'off', seen: null }, pr: { configured: input.prReviewer ? 'on' : 'off', seen: null } },
    };
}

/**
 * Agents a hook recorded that have no row yet: a known agent with no hook config here (switched off, as setup would
 * say), or an id setup does not know (RIGOUR_AGENT_ID), shown as recorded with nothing configured to say.
 */
function otherAgents(recent: Sighting[], rows: CoverageRow[], input: CoverageInputs, last: (stage: Stage, agent?: string) => string | null): CoverageRow[] {
    const have = new Set(rows.map(r => agentId(r.agent)));
    const ids = [...new Set(recent.map(s => s.agent).filter((a): a is string => !!a && !have.has(a)))].sort();
    const known = new Set(Object.values(AGENT_NAMES));
    return ids.map(id => {
        if (!known.has(id)) {
            return {
                agent: id,
                note: 'An id a hook recorded (RIGOUR_AGENT_ID); setup does not read its config.',
                cells: Object.fromEntries(STAGES.map(s => [s, { configured: null, seen: last(s, id) }])) as Record<Stage, CoverageCell>,
            };
        }
        const off = (stage: Stage): CoverageCell => ({ configured: 'off', seen: last(stage, id) });
        return {
            agent: id,
            note: 'Seen here, but no hook config for it was found.',
            cells: { brief: { configured: 'not checked', seen: last('brief', id) }, edit: off('edit'), stop: off('stop'), push: { configured: input.pushGate ? 'on' : 'off', seen: null }, pr: { configured: input.prReviewer ? 'on' : 'off', seen: null } },
        };
    });
}

/** The name a row is matched on: setup's name without its file ("Windsurf (.devin/hooks.json)" is Windsurf). */
function agentId(name: string): string {
    return name.replace(/\s*\(.*\)$/, '');
}

/** A recorded agent as setup names it; an id setup does not know stays as recorded; none for a way of asking. */
function recorded(agent: unknown): string | undefined {
    if (typeof agent !== 'string' || !agent.trim() || NOT_AGENTS.has(agent)) return undefined;
    return AGENT_NAMES[agent.toLowerCase()] ?? agent;
}

/**
 * Each time a moment fired: from the threads, or, where none were kept (a Rigour from before threads), from the event
 * log. Not both: the log does not name Cursor where its thread does, so the same check would count twice.
 */
function sightings(input: CoverageInputs): Sighting[] {
    const stageOf: Partial<Record<string, Stage>> = { brief: 'brief', 'edit-check': 'edit', 'stop-review': 'stop', push: 'push', review: 'pr' };
    const fromThreads = input.threads.flatMap((e): Sighting[] => {
        const stage = stageOf[e.kind];
        // The push gate and the reviewer act for whoever pushed: they record no agent.
        return stage ? [{ stage, at: e.at, agent: stage === 'push' || stage === 'pr' ? undefined : recorded(e.agent) }] : [];
    });
    if (fromThreads.length) return fromThreads;
    return input.events.flatMap((e): Sighting[] => {
        if (!e.timestamp) return [];
        if (e.type === 'hook_check') return [{ stage: 'edit', at: e.timestamp, agent: recorded((e as AgentEvent & { agentId?: string }).agentId) }];
        if (e.type === 'stop_review') return [{ stage: 'stop', at: e.timestamp, agent: recorded(e.tool) }];
        return [];
    });
}
