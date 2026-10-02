/**
 * Studio's "Activity": what Rigour did, newest first, one plain sentence per thing that happened.
 * Built from the event log, the review ledger and stories across every checkout; internal ids and
 * raw tool traffic are left out.
 */
import path from 'path';
import { readLedger, type AgentEvent, type LedgerEntry, type Story } from '@rigour-labs/core';
import { checkoutRoots, eventsAcross, storiesAcross } from './studio-checkouts.js';

const LIMIT = 200;

export type ActivityKind = 'stopped' | 'fixed' | 'checked' | 'reviewed' | 'taught' | 'pr';

export interface ActivityItem {
    at: string;
    kind: ActivityKind;
    text: string;
    detail?: string;
}

interface HookFinding { message?: string; file?: string; line?: number }

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
const IMPORTANT: ActivityKind[] = ['stopped', 'fixed', 'pr'];

export interface ActivitySession {
    start: string;
    end: string;
    counts: Record<ActivityKind, number> & { reviewedFixed: number };
    /** What a person should see: blocks, fixes, PR catches, fixes found in review. */
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
        const counts = { stopped: 0, fixed: 0, checked: 0, reviewed: 0, taught: 0, pr: 0, reviewedFixed: 0 };
        for (const item of list) {
            counts[item.kind]++;
            if (item.kind === 'reviewed' && item.text.startsWith('Fixed ')) counts.reviewedFixed++;
        }
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
            return [{ at, kind: 'stopped', text: `Stopped an edit to ${files}: ${findings.map(f => f.message).filter(Boolean).join('; ')}` }];
        }
        case 'stop_review':
            return [event.blocked
                ? { at, kind: 'stopped', text: `Kept the agent working: ${count(event.blocking ?? 0, 'problem')} left when it tried to finish` }
                : { at, kind: 'checked', text: 'The agent finished with nothing blocking' }];
        case 'lessons_served':
            return [{ at, kind: 'taught', text: `Told the agent ${count(event.lessons?.length ?? 0, 'lesson')} before it wrote`, detail: event.lessons?.join(' · ') }];
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
    return files.length > 0 && files.every(f => path.isAbsolute(f) && !roots.some(root => f.startsWith(root + path.sep)));
}
