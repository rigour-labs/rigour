/**
 * Two or three judges as a panel, run around the consensus rules (consensus.ts). The judges' own
 * items are grouped into findings; a finding a strict majority raised is confirmed. Every other
 * judge then cross-examines, in one batched call each, only the findings it did not raise: confirm
 * or refute with file:line evidence; no evidence or no answer is unsure. The calls decide by
 * majority; a disputed finding is shown and never blocks. A finding disputed before, on a file no
 * commit has touched since, stays disputed without another call; past the item cap, disputed too.
 *
 * Every finding keeps what a later re-scoring needs (who raised it, every judge's call, the
 * cross-examination answers, each judge's own item and the class), so a probabilistic truth model
 * can be fitted to the ledger later without running anyone again.
 */
import { clusterItems, MATCH_THRESHOLD, order, similarity, statusOf, type Call, type PanelStatus } from './consensus.js';
import type { OpenItem } from './verdict.js';

export interface PanelItem {
    /** The item as its first raiser reported it. */
    item: OpenItem;
    /** The judges who raised it unprompted. */
    judges: string[];
    /** Every judge's call on it, raised or answered in cross-examination. */
    calls: Record<string, Call>;
    /** Every cross-examination answer about it, with the code each judge quoted. */
    cross?: Array<{ by: string; call: Call; evidence?: string }>;
    /** Each judge's own item when more than one wrote it: what a later re-scoring of the panel needs. */
    members?: Array<{ judge: string; item: OpenItem }>;
    status: PanelStatus;
    /** Why it is disputed without a cross-examination (over the cap, disputed before and untouched since). */
    note?: string;
}

/** A judge's answer about another judge's items: confirm or refute, each with the code that shows it. */
export interface Answer { id: string; call: 'confirm' | 'refute' | 'unsure'; evidence?: string }

export interface PanelInput {
    judges: string[];
    items: OpenItem[][];
    /** Items disputed in the previous verdict, and the files changed since it. */
    previousDisputed: OpenItem[];
    touched: Set<string>;
    maxItems: number;
    /** Asks `judge` about items other judges raised; resolves to its answers (a missing one counts as unsure). */
    ask: (judge: string, items: OpenItem[]) => Promise<Answer[]>;
    /** Why no more agent runs may start today (a daily cap), checked before each judge's cross-examination. */
    capped?: () => string | undefined;
    /** Whether an answer's evidence quotes real code: a `file:line` the checkout has. */
    evidenced: (evidence: string) => boolean;
}

/** The panel's decision on every finding any judge raised. */
export async function runPanel(input: PanelInput): Promise<PanelItem[]> {
    const n = input.judges.length;
    const clusters = clusterItems(input.judges, input.items);
    const decided: PanelItem[] = clusters.map(c => {
        const raisers = [...new Set(c.members.map(m => m.judge))];
        const calls: Record<string, Call> = Object.fromEntries(raisers.map(j => [j, 'raised' as Call]));
        const item = { ...c.members[0].item, evidence: c.members.map(m => m.item.evidence).find(Boolean) };
        return { item, judges: raisers, calls, status: statusOf(calls, n), ...(c.members.length > 1 ? { members: c.members } : {}) };
    });
    const undecided = decided.filter(d => d.status !== 'confirmed');
    const disputedBefore = (item: OpenItem) => !!item.file && !input.touched.has(item.file) && input.previousDisputed.some(p => similarity(item, p) >= MATCH_THRESHOLD);
    for (const d of undecided.filter(d => disputedBefore(d.item))) {
        for (const judge of input.judges) d.calls[judge] ??= 'not asked';
        d.status = 'disputed';
        d.note = 'disputed before; its file is unchanged since';
    }
    const toAsk = undecided.filter(d => !d.note).sort((a, b) => order(a.item, b.item));
    for (const d of toAsk.slice(input.maxItems)) {
        for (const judge of input.judges) d.calls[judge] ??= 'not asked';
        d.status = 'disputed';
        d.note = `over review.reviewer.panel_max_items (${input.maxItems})`;
    }
    const asked = toAsk.slice(0, input.maxItems);
    // One batched call per judge, about every asked finding it did not raise; the calls run together.
    await Promise.all(input.judges.map(async judge => {
        const mine = asked.filter(d => !d.judges.includes(judge));
        if (!mine.length) return;
        const cap = input.capped?.();
        if (cap) {
            for (const d of mine) {
                d.calls[judge] = 'not asked';
                d.note = cap;
            }
            return;
        }
        let answers: Answer[] = [];
        try {
            answers = await input.ask(judge, mine.map(d => d.item));
        } catch {
            answers = [];
        }
        for (const d of mine) {
            const answer = answers.find(x => x.id === d.item.id);
            const evidenced = !!answer?.evidence && input.evidenced(answer.evidence);
            d.calls[judge] = answer && evidenced ? answer.call : 'unsure';
            d.cross = [...(d.cross ?? []), { by: judge, call: d.calls[judge], ...(answer?.evidence ? { evidence: answer.evidence } : {}) }];
        }
    }));
    for (const d of asked) d.status = statusOf(d.calls, n);
    return decided.sort((x, y) => order(x.item, y.item));
}

/** The answers in a judge's cross-examination reply; nothing usable is no answers (every item then disputed). */
export function parseAnswers(text: string): Answer[] {
    const candidates = [text.trim(), ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1].trim()), ...[...text.matchAll(/\{\s*"answers"/g)].map(m => text.slice(m.index))];
    for (const candidate of candidates) {
        for (let end = candidate.lastIndexOf('}'); end > 0; end = candidate.lastIndexOf('}', end - 1)) {
            try {
                const parsed = JSON.parse(candidate.slice(0, end + 1));
                if (!Array.isArray(parsed?.answers)) continue;
                return parsed.answers.filter((a: any) => typeof a?.id === 'string' && ['confirm', 'refute', 'unsure'].includes(a.call))
                    .map((a: any) => ({ id: a.id, call: a.call, ...(typeof a.evidence === 'string' ? { evidence: a.evidence } : {}) }));
            } catch {
                // not a whole object yet: try a shorter one
            }
        }
    }
    return [];
}

/** The accounting with the panel's decision applied: the judges' own items leave, and only what it confirmed blocks. */
export function applyPanel<T extends { open: OpenItem[] }>(accounted: T, judgeItemIds: Set<string>, decided: PanelItem[]): T & { disputed: OpenItem[]; dropped: OpenItem[] } {
    const withJudges = (d: PanelItem): OpenItem => ({ ...d.item, reviewer: d.judges.join('+') });
    const confirmed = decided.filter(d => d.status === 'confirmed').map(withJudges);
    const open = [...accounted.open.filter(item => !judgeItemIds.has(item.id)), ...confirmed.filter(c => !accounted.open.some(o => o.id === c.id && !judgeItemIds.has(o.id)))];
    return {
        ...accounted,
        open,
        disputed: decided.filter(d => d.status === 'disputed').map(withJudges),
        dropped: decided.filter(d => d.status === 'dropped').map(withJudges),
    };
}
