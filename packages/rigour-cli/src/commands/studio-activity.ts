/**
 * Studio's "Activity": what Rigour did, newest first, one plain sentence per thing that happened.
 * Built from the event log, the review ledger and stories across every checkout; internal ids and
 * raw tool traffic are left out.
 */
import path from 'path';
import { readLedger, type AgentEvent, type LedgerEntry, type Story } from '@rigour-labs/core';
import { checkoutRoots, eventsAcross, storiesAcross } from './studio-checkouts.js';

const LIMIT = 200;

export type ActivityKind = 'stopped' | 'reported' | 'fixed' | 'checked' | 'reviewed' | 'taught' | 'pr';

export interface ActivityItem {
    at: string;
    kind: ActivityKind;
    text: string;
    detail?: string;
    /** The problems a stopped item is about (check and file, as the open-findings ledger keys them): one problem stopped at an edit and again at the stop counts once. */
    problems?: string[];
}

interface HookFinding { message?: string; file?: string; line?: number; gate?: string }

/** A problem as the open-findings ledger keys it: its check and its file. */
const problemKey = (check: string | undefined, file: string | undefined) => `${check ?? '?'}:${file ?? '?'}`;

export function buildActivity(input: { events: AgentEvent[]; ledger: LedgerEntry[]; stories: Story[] }): ActivityItem[] {
    const items: ActivityItem[] = [
        ...input.events.flatMap(e => fromEvent(e)),
        ...input.ledger.map(entry => ({
            at: entry.at, kind: 'reviewed' as const,
            text: entry.verdict === 'fixed'
                ? `Fixed ${readableFunction(entry.function, entry.file)} in ${entry.file}`
                : `Reviewed ${readableFunction(entry.function, entry.file)} in ${entry.file}: ${entry.verdict === 'no_issue' ? 'no issue' : entry.verdict}`,
            detail: entry.note || undefined,
        })),
        ...input.stories.map(s => ({ at: s.at, kind: 'fixed' as const, text: `Fixed: ${s.title}`, detail: s.file })),
    ];
    return items.filter(i => i.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT);
}

/** `<anonymous>@17` is how the parser names an unnamed function; people read "the test at line 17". */
export function readableFunction(name: string, file: string): string {
    const anon = name.match(/^<anonymous>@(\d+)$/);
    if (!anon) return `\`${name}\``;
    return /\.(test|spec)\.[jt]sx?$/.test(file) ? `the test at line ${anon[1]}` : `the function at line ${anon[1]}`;
}

/** A gap this long between two things Rigour did starts a new session. */
const SESSION_GAP_MS = 45 * 60 * 1000;
const IMPORTANT: ActivityKind[] = ['stopped', 'reported', 'fixed', 'pr'];

export interface ActivitySession {
    start: string;
    end: string;
    counts: Record<ActivityKind, number> & { reviewedFixed: number };
    /** What a person should see: blocks, findings reported on an edit, fixes, PR catches, fixes found in review. */
    highlights: ActivityItem[];
    /** The routine rest, shown on request. */
    rest: ActivityItem[];
}

/** Items (newest first) grouped into working sessions, each summarised. */
export function groupSessions(items: ActivityItem[]): ActivitySession[] {
    const sessions: ActivityItem[][] = [];
    for (const item of items) {
        const current = sessions[sessions.length - 1];
        const last = current?.[current.length - 1];
        if (last && Date.parse(last.at) - Date.parse(item.at) <= SESSION_GAP_MS) current.push(item);
        else sessions.push([item]);
    }
    return sessions.map(list => {
        const counts = { stopped: 0, reported: 0, fixed: 0, checked: 0, reviewed: 0, taught: 0, pr: 0, reviewedFixed: 0 };
        const stopped = new Set<string>();
        for (const item of list) {
            if (item.kind === 'stopped') {
                for (const [i, problem] of (item.problems ?? [`${item.at}#0`]).entries()) stopped.add(problem || `${item.at}#${i}`);
                continue;
            }
            counts[item.kind]++;
            if (item.kind === 'reviewed' && item.text.startsWith('Fixed ')) counts.reviewedFixed++;
        }
        counts.stopped = stopped.size;
        const highlight = (i: ActivityItem) => IMPORTANT.includes(i.kind) || (i.kind === 'reviewed' && i.text.startsWith('Fixed '));
        return { start: list[list.length - 1].at, end: list[0].at, counts, highlights: list.filter(highlight), rest: list.filter(i => !highlight(i)) };
    });
}

function fromEvent(event: AgentEvent): ActivityItem[] {
    const at = event.timestamp ?? '';
    const raw = event as AgentEvent & { files?: string[]; findings?: HookFinding[] | AgentEvent['findings'] };
    switch (event.type) {
        case 'hook_check': {
            const findings = (raw.findings ?? []) as HookFinding[];
            const files = (raw.files ?? []).join(', ');
            if (findings.length === 0) return [{ at, kind: 'checked', text: `Checked an edit to ${files || 'a file'}: nothing found` }];
            const found = findings.map(f => f.message).filter(Boolean).join('; ');
            // Stopped only when the hook ran with --block and said so; an event without the flag never claims a block.
            return [event.blocked
                ? { at, kind: 'stopped', text: `Stopped an edit to ${files}: ${found}`, problems: findings.map(f => problemKey(f.gate, f.file)) }
                : { at, kind: 'reported', text: `Reported on an edit to ${files}: ${found}` }];
        }
        case 'stop_review': {
            if (!event.blocked) return [{ at, kind: 'checked', text: 'The agent finished with nothing blocking' }];
            // What held it, as the edit line names what it stopped; an older record has only the count.
            const held = event.findings ?? [];
            const named = (f: { title: string; file: string; detail?: string }) => `${f.file ? `${f.file}: ` : ''}${f.title}${f.detail ? ` (${f.detail})` : ''}`;
            if (held.length === 1 && (event.blocking ?? 1) === 1) return [{ at, kind: 'stopped', text: `Kept the agent working: ${named(held[0])}`, problems: [problemKey(held[0].rule, held[0].file)] }]; // written at the block: the "Fixed" story says when it was fixed
            // An older record names no problems: each counts as its own.
            const problems = held.length ? held.map(f => problemKey(f.rule, f.file)) : Array.from({ length: event.blocking ?? 1 }, (_, i) => `${at}#${i}`);
            return [{ at, kind: 'stopped', text: `Kept the agent working: ${count(event.blocking ?? held.length, 'problem')} left when it tried to finish`, problems, ...(held.length ? { detail: held.map(named).join(' · ') } : {}) }];
        }
        case 'lessons_served': {
            const items = event.lessons?.length ?? 0;
            if (event.via !== 'brief') return [{ at, kind: 'taught', text: `Told the agent ${count(items, 'lesson')} before it wrote`, detail: event.lessons?.join(' · ') }];
            // A briefing: the repository's rules and the team's lessons, for the files the task touches.
            const rules = event.rules ?? 0;
            const told = [rules ? count(rules, 'rule') : '', items - rules ? count(items - rules, 'lesson') : ''].filter(Boolean).join(' and ');
            return [{ at, kind: 'taught', text: `Briefed the agent before it wrote: ${told}${event.files?.length ? ` for ${event.files.join(', ')}` : ''}`, detail: event.lessons?.join(' · ') }];
        }
        case 'pr_catches':
            return [{ at, kind: 'pr', text: `A branch review found ${count(event.findings?.length ?? 0, 'problem')}`, detail: event.findings?.map(f => `${f.title} (${f.file})`).join(' · ') }];
        default:
            return [];
    }
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function loadActivity(cwd: string): ActivitySession[] {
    const roots = checkoutRoots(cwd);
    const events = eventsAcross(roots).filter(e => !aboutAnotherRepository(e, roots));
    // Review fixes are already in the ledger; their story copies would list each one twice.
    const stories = storiesAcross(roots).filter(story => story.rule !== 'review');
    return groupSessions(buildActivity({ events, ledger: roots.flatMap(readLedger), stories }));
}

/** Older edit hooks logged every file into the session's folder, even files in other repositories. */
export function aboutAnotherRepository(event: AgentEvent, roots: string[]): boolean {
    const files = (event as AgentEvent & { files?: string[] }).files ?? [];
    return files.length > 0 && files.every(f => path.isAbsolute(f) && !roots.some(root => isInside(root, f)));
}

/** True when `file` is inside `root`, whichever separators either uses. */
function isInside(root: string, file: string): boolean {
    const rel = path.relative(root, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
