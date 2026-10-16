/**
 * The four moments of an agent's development loop (briefed, each edit checked, the stop review when it says done, the
 * push), one record each, from the two places Rigour writes them:
 * - the task threads in the git common folder (every worktree, with the branch and, where the hook knows it, the agent);
 * - each checkout's .rigour/events.jsonl (what the check said: the findings, whether the edit was blocked, what held the stop).
 * A hook writes both at the same moment, so a check in both is one check: the thread's record, with the event's detail.
 * An event no thread holds (written before threads were kept, or on a detached head) is counted from the event alone.
 */
import fs from 'fs';
import path from 'path';
import type { AgentEvent } from '@rigour-labs/core';
import { recordedAgent } from './studio-agents.js';
import { jsonLines } from './studio-files.js';

export type DevStage = 'brief' | 'edit' | 'stop' | 'push';

export interface DevRecord {
    at: string;
    stage: DevStage;
    branch: string | null;
    /** As the hook recorded it; null when it did not. */
    agent: string | null;
    session: string | null;
    files: string[];
    /** brief: items told; edit: findings reported; stop: problems that held it; push: checks that failed. */
    count: number;
    /** edit: blocked by a --block hook; stop: sent the agent back; push: held. null when not recorded. */
    held: boolean | null;
    /** What was said: finding messages, problems held, lessons told. Only events.jsonl keeps these. */
    said: string[];
    /** stop: nothing had changed since the last review. null when not recorded. */
    nothingToReview?: boolean | null;
    /** brief: how many of the items were the repository's rules. null when not recorded. */
    rules?: number | null;
}

/** Thread lines of the four development kinds, from files written to since `since` (older files cannot hold newer lines). */
export function readThreadRecords(dir: string | undefined, since: number): DevRecord[] {
    if (!dir) return [];
    return threadFiles(dir)
        .filter(file => modifiedSince(file, since))
        .flatMap(readLines)
        .flatMap(fromThread)
        .filter(r => Date.parse(r.at) >= since);
}

/** The earliest moment any thread recorded: each file's first line, as threads are only appended to. */
export function threadsStart(dir: string | undefined): string | null {
    if (!dir) return null;
    const firsts = threadFiles(dir).map(firstLineAt).filter((at): at is string => !!at).sort();
    return firsts[0] ?? null;
}

function threadFiles(dir: string): string[] {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
    } catch {
        return [];
    }
}

function modifiedSince(file: string, since: number): boolean {
    try {
        return fs.statSync(file).mtimeMs >= since;
    } catch {
        return false;
    }
}

function readLines(file: string): Array<Record<string, unknown>> {
    return jsonLines<Record<string, unknown>>(file).filter(line => line && typeof line.at === 'string' && typeof line.kind === 'string');
}

function firstLineAt(file: string): string | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(4096);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const at = JSON.parse(buffer.toString('utf8', 0, read).split('\n')[0]).at;
        return typeof at === 'string' ? at : undefined;
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

const THREAD_STAGE: Record<string, DevStage> = { brief: 'brief', 'edit-check': 'edit', 'stop-review': 'stop', push: 'push' };

function fromThread(line: Record<string, unknown>): DevRecord[] {
    const stage = THREAD_STAGE[String(line.kind)];
    if (!stage) return [];
    const base = {
        at: String(line.at), stage, branch: str(line.branch), agent: recordedAgent(line.agent), session: str(line.session),
        files: strings(line.files), said: [] as string[],
    };
    if (stage === 'brief') return [{ ...base, count: num(line.items), held: null, rules: null }];
    if (stage === 'edit') return [{ ...base, count: num(line.findings), held: null }];
    if (stage === 'stop') return [{ ...base, count: num(line.blocking), held: line.blocked === true, nothingToReview: null }];
    return [{ ...base, count: num(line.failed), held: line.passed === false }];
}

type HookFinding = { message?: string; title?: string; file?: string; detail?: string };

/** events.jsonl lines of the development kinds as records: no branch, the agent only where the line names it. */
export function fromEvents(events: AgentEvent[], since: number): DevRecord[] {
    return events.flatMap((event): DevRecord[] => {
        if (!event.timestamp || !(Date.parse(event.timestamp) >= since)) return [];
        const raw = event as Omit<AgentEvent, 'findings'> & { agentId?: string; findings?: HookFinding[] };
        const base = { at: event.timestamp, branch: null, session: str(event.session), files: event.files ?? [] };
        if (event.type === 'hook_check') {
            const findings = raw.findings ?? [];
            return [{ ...base, stage: 'edit', agent: recordedAgent(raw.agentId), count: findings.length, held: event.blocked === true, said: findings.map(f => f.message ?? '').filter(Boolean) }];
        }
        if (event.type === 'stop_review') {
            const held = raw.findings ?? [];
            const said = held.map(f => `${f.file ? `${f.file}: ` : ''}${f.title ?? ''}${f.detail ? ` (${f.detail})` : ''}`);
            return [{ ...base, stage: 'stop', agent: recordedAgent(event.tool), count: event.blocking ?? held.length, held: event.blocked === true, said, nothingToReview: event.nothing_to_review === true }];
        }
        if (event.type === 'lessons_served' && event.via === 'brief') {
            return [{ ...base, stage: 'brief', agent: null, count: event.lessons?.length ?? 0, held: null, said: event.lessons ?? [], rules: event.rules ?? 0 }];
        }
        return [];
    });
}

/** Written by the same hook call: a thread line and its event line are this close in time. */
const SAME_MOMENT_MS = 5000;

interface Timed { ms: number; record: DevRecord }

/** Thread records with the detail of the event line written beside each, then the events no thread holds; oldest first. */
export function joinRecords(threads: DevRecord[], events: DevRecord[]): DevRecord[] {
    const byStage = new Map<DevStage, Timed[]>();
    for (const record of threads) {
        const list = byStage.get(record.stage) ?? [];
        list.push({ ms: Date.parse(record.at), record });
        byStage.set(record.stage, list);
    }
    for (const list of byStage.values()) list.sort((a, b) => a.ms - b.ms);
    const merged = new Map<DevRecord, DevRecord>();
    const alone: DevRecord[] = [];
    for (const event of events) {
        const match = nearest(byStage.get(event.stage) ?? [], event, merged);
        if (match) merged.set(match, withDetail(match, event));
        else alone.push(event);
    }
    return [...threads.map(t => merged.get(t) ?? t), ...alone].sort((a, b) => a.at.localeCompare(b.at));
}

/** The closest thread record of the same check, not yet joined, within the same moment (binary search on time). */
function nearest(list: Timed[], event: DevRecord, taken: Map<DevRecord, DevRecord>): DevRecord | undefined {
    const ms = Date.parse(event.at);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].ms < ms - SAME_MOMENT_MS) lo = mid + 1;
        else hi = mid;
    }
    let best: { gap: number; record: DevRecord } | undefined;
    for (let i = lo; i < list.length && list[i].ms <= ms + SAME_MOMENT_MS; i++) {
        const { record } = list[i];
        const gap = Math.abs(list[i].ms - ms);
        if (!taken.has(record) && sameCheck(record, event) && (!best || gap < best.gap)) best = { gap, record };
    }
    return best?.record;
}

function sameCheck(thread: DevRecord, event: DevRecord): boolean {
    if (thread.session && event.session && thread.session !== event.session) return false;
    if (thread.stage === 'stop' || !event.files.length || !thread.files.length) return true;
    return event.files.some(f => thread.files.includes(f));
}

function withDetail(thread: DevRecord, event: DevRecord): DevRecord {
    return {
        ...thread,
        agent: thread.agent ?? event.agent,
        held: thread.stage === 'edit' ? event.held : thread.held,
        said: event.said,
        ...(thread.stage === 'stop' ? { nothingToReview: event.nothingToReview } : {}),
        ...(thread.stage === 'brief' ? { rules: event.rules } : {}),
    };
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
