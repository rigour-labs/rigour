/**
 * A reviewer's answer as a verdict, several verdicts as one, and the open items a verdict leaves:
 * each with a stable id, so a later run, the branch record and a reply all name the same thing.
 * Fails closed: an API error, a timeout, a crash or a malformed answer is never a pass. In delta
 * mode nothing from the previous verdict disappears silently: an item the reviewer neither carried
 * nor resolved with evidence stays open, marked "not accounted for". Every item that names code is
 * checked against the checkout before it can block: a file not in the repository, or a line past
 * its end, is a reviewer's slip, reported apart and never a block.
 */
import { createHash } from 'crypto';
import type { Spend, Tokens } from './adapters.js';
import type { PanelItem } from './panel.js';

export interface PriorPoint { point: string; review?: string; severity?: 'blocking' | 'should-fix' | 'non-blocking'; resolved: boolean; evidence?: string; checked_siblings?: string[]; reviewer?: string }
interface Redundant { file: string; line?: number; what: string; made_redundant_by?: string; removed: boolean; reviewer?: string }
interface Read { file: string; line?: number; read: string; rules?: Array<{ rule: string; known_before_read: boolean; applied_before_read: boolean }>; narrower_source?: string | null; keys?: Array<{ name: string; inputs: string; stable_under_edit: boolean }>; window_bounded?: boolean | null; keyset?: boolean | null; reviewer?: string }
interface Scan { file: string; line?: number; function: string; outer: string; inner: string; fix: string; reviewer?: string }
interface MergeImpactItem { symbol: string; main_file: string; call_site: string; holds: boolean; why: string; reviewer?: string }
export interface Finding { class: string; file: string; line?: number; issue: string; why?: string; consequence?: string; reviewer?: string }

export interface Verdict {
    prior_points: PriorPoint[];
    redundant: Redundant[];
    reads: Read[];
    scans: Scan[];
    merge_impact: MergeImpactItem[];
    findings: Finding[];
    carried: string[];
    resolved_previous: Array<{ id: string; evidence: string }>;
    reviewer?: string;
    cost_usd?: number;
    tokens?: Tokens;
    reviewers?: Array<{ reviewer: string; cost_usd?: number; tokens?: Tokens }>;
    /** With a panel: every judge's own item ids, and the panel's decision on each finding (reviewer/panel.ts). */
    panel?: { judgeItemIds: string[]; items: PanelItem[] };
}

export interface OpenItem {
    id: string;
    kind: 'prior' | 'redundant' | 'read' | 'scan' | 'merge' | 'finding';
    class: string;
    file?: string;
    line?: number;
    issue: string;
    evidence?: string;
    /** For a finding: the wrong outcome or the cost. A finding without one is a note, never a block. */
    consequence?: string;
    reviewer?: string;
    /** In delta mode, how the item reached this verdict. */
    status?: 'carried' | 'not accounted for';
}

/** Checks a file (and a line) against the checkout; an item that fails cannot block. */
export type Verify = (file: string, line: number | undefined) => boolean;

const SHAPE: Array<keyof Verdict> = ['prior_points', 'reads', 'findings'];
const LISTS: Array<keyof Verdict> = ['redundant', 'scans', 'merge_impact', 'carried', 'resolved_previous'];

/** The verdict in a reviewer's answer, or why it is not one. `needsPriorPoints`: a human review exists and none of its points is carried. */
export function parseVerdict(text: string, needsPriorPoints: boolean, reviewer: string, spend: Spend): { verdict: Verdict } | { error: string } {
    const parsed = verdictIn(text);
    if (!parsed || !SHAPE.every(key => Array.isArray(parsed[key]))) return { error: `${reviewer}: no valid verdict (${text.slice(0, 200).replace(/\s+/g, ' ')})` };
    if (needsPriorPoints && parsed.prior_points.length === 0) return { error: `${reviewer} did not report on the human reviews` };
    for (const key of LISTS) if (!Array.isArray(parsed[key])) parsed[key] = [];
    return { verdict: { ...parsed, reviewer, ...(spend.costUsd !== undefined ? { cost_usd: spend.costUsd } : {}), ...(spend.tokens ? { tokens: spend.tokens } : {}) } };
}

/** The whole answer, a fenced block, or the last object that starts with "prior_points" (a model sometimes writes a summary around it). */
function verdictIn(text: string): any {
    const candidates = [
        text.trim(),
        ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1].trim()).reverse(),
        ...[...text.matchAll(/\{\s*"prior_points"/g)].map(m => text.slice(m.index)).reverse(),
    ];
    for (const candidate of candidates) {
        for (let end = candidate.lastIndexOf('}'); end > 0; end = candidate.lastIndexOf('}', end - 1)) {
            try {
                const parsed = JSON.parse(candidate.slice(0, end + 1));
                if (parsed && typeof parsed === 'object' && 'prior_points' in parsed) return parsed;
            } catch {
                // not a whole object yet: try a shorter one
            }
        }
    }
    return undefined;
}

/** Several reviewers as one: a prior point is resolved only when every reviewer says so; every other item stands, tagged with who found it. */
export function mergeVerdicts(parts: Verdict[]): Verdict {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    const prior = new Map<string, PriorPoint>();
    for (const part of parts) {
        for (const point of part.prior_points) {
            const key = norm(point.point);
            const current = prior.get(key);
            if (!current || (current.resolved && !point.resolved)) prior.set(key, { ...point, reviewer: part.reviewer });
        }
    }
    const tagged = <T extends { reviewer?: string }>(pick: (part: Verdict) => T[]) => parts.flatMap(part => pick(part).map(item => ({ ...item, reviewer: part.reviewer })));
    return {
        prior_points: [...prior.values()],
        redundant: tagged(part => part.redundant),
        reads: tagged(part => part.reads),
        scans: tagged(part => part.scans),
        merge_impact: tagged(part => part.merge_impact),
        findings: tagged(part => part.findings),
        carried: parts.flatMap(part => part.carried),
        resolved_previous: parts.length === 1 ? parts[0].resolved_previous : parts[0].resolved_previous.filter(x => parts.every(part => part.resolved_previous.some(y => y.id === x.id))),
        reviewers: parts.map(part => ({ reviewer: part.reviewer ?? '?', ...(part.cost_usd !== undefined ? { cost_usd: part.cost_usd } : {}), ...(part.tokens ? { tokens: part.tokens } : {}) })),
    };
}

/**
 * Delta mode: a human point the previous verdict resolved stays resolved unless the new commits
 * touch a file its evidence names; it is carried into the new verdict so nothing disappears, and
 * the reviewer is not paid to judge it again.
 */
export function carryResolved(verdict: Verdict, previous: Verdict | undefined, touched: Set<string>): Verdict {
    if (!previous) return verdict;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    const judged = new Set(verdict.prior_points.map(p => norm(p.point)));
    const carried = previous.prior_points.filter(p => p.resolved && !judged.has(norm(p.point)) && !evidenceTouched(p.evidence, touched));
    return carried.length ? { ...verdict, prior_points: [...verdict.prior_points, ...carried] } : verdict;
}

/** True when the evidence names a file in the set (`src/a.ts:12`, `src/a.ts`). */
export function evidenceTouched(evidence: string | undefined, touched: Set<string>): boolean {
    for (const match of (evidence ?? '').matchAll(/[\w./-]+\.[A-Za-z]+/g)) if (touched.has(match[0])) return true;
    return false;
}

export interface Accounting {
    /** What blocks: everything the reviewers reported that checks out, plus previous items still open. */
    open: OpenItem[];
    /** Items naming code the checkout does not have: shown, never a block. */
    unverified: OpenItem[];
    /** Previous open items the reviewer resolved, with the evidence. */
    resolved: Array<{ item: OpenItem; evidence: string }>;
    /** Prior points the human marked non-blocking and the code still leaves open: for the reply. */
    answerInReply: PriorPoint[];
    /** Findings with no wrong outcome and no cost (an opinion): shown, never a block, however many judges agree. */
    notes: OpenItem[];
}

const id = (...parts: Array<string | number | undefined>) => createHash('sha1').update(parts.map(p => String(p ?? '')).join('|').toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 10);

/** Everything the reviewers reported blocks; in delta mode, previous open items carry unless resolved with evidence. */
export function account(verdict: Verdict, previousOpen: OpenItem[] | undefined, verify: Verify): Accounting {
    const open: OpenItem[] = [];
    const unverified: OpenItem[] = [];
    const seen = new Set<string>();
    // A prior point is the human's and needs no file; anything else must name code the checkout has.
    const add = (item: OpenItem) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        const placed = item.kind === 'prior' || (!!item.file && verify(item.file, item.line));
        (placed ? open : unverified).push(item);
    };
    const answerInReply: PriorPoint[] = [];
    for (const p of verdict.prior_points) {
        if (p.resolved) continue;
        if (p.severity === 'non-blocking') answerInReply.push(p);
        else add({ id: id('prior', p.review, p.point), kind: 'prior', class: 'prior point', issue: p.point, evidence: p.evidence, reviewer: p.reviewer });
    }
    for (const r of verdict.redundant) {
        if (r.removed === false) add({ id: id('dead-code', r.file, r.what), kind: 'redundant', class: 'dead-code', file: r.file, line: r.line, issue: r.what, evidence: r.made_redundant_by ? `made redundant by ${r.made_redundant_by}` : undefined, reviewer: r.reviewer });
    }
    for (const r of verdict.reads) {
        const problems: Array<{ cls: string; text: string }> = [
            ...(r.rules ?? []).filter(x => x.known_before_read && x.applied_before_read !== true).map(x => ({ cls: 'production-cost', text: `known before the read, applied after: ${x.rule}` })),
            ...(r.narrower_source ? [{ cls: 'production-cost', text: `narrower source: ${r.narrower_source}` }] : []),
            ...(r.window_bounded === false ? [{ cls: 'production-cost', text: 'window not bounded at both ends' }] : []),
            ...(r.keyset === false ? [{ cls: 'production-cost', text: 'OFFSET paging' }] : []),
            ...(r.keys ?? []).filter(k => k.stable_under_edit === false).map(k => ({ cls: 'correctness', text: `key ${k.name} changes when the user edits: ${k.inputs}` })),
        ];
        for (const p of problems) add({ id: id(p.cls, r.file, r.read, p.text), kind: 'read', class: p.cls, file: r.file, line: r.line, issue: `${r.read}: ${p.text}`, reviewer: r.reviewer });
    }
    for (const s of verdict.scans) add({ id: id('production-cost', s.file, s.function), kind: 'scan', class: 'production-cost', file: s.file, line: s.line, issue: `${s.function} scans ${s.inner} per item of ${s.outer}`, evidence: s.fix, reviewer: s.reviewer });
    for (const m of verdict.merge_impact) {
        if (m.holds === false) add({ id: id('correctness', m.call_site, m.symbol), kind: 'merge', class: 'correctness', file: m.call_site.split(':')[0], line: Number(m.call_site.split(':')[1]) || undefined, issue: `${m.symbol} from ${m.main_file} changed in main: ${m.why}`, reviewer: m.reviewer });
    }
    const notes: OpenItem[] = [];
    const stillOpen = new Set((previousOpen ?? []).map(item => item.id));
    for (const f of verdict.findings) {
        const item: OpenItem = { id: id(f.class, f.file, f.issue), kind: 'finding', class: f.class, file: f.file, line: f.line, issue: f.issue, evidence: f.why, ...(f.consequence?.trim() ? { consequence: f.consequence.trim() } : {}), reviewer: f.reviewer };
        // An opinion is a finding the judge said has no consequence: an empty one. A missing field fails closed, and an
        // item already open from the last round stays open until it is resolved with evidence.
        const opinion = typeof f.consequence === 'string' && !f.consequence.trim() && !stillOpen.has(item.id);
        if (!opinion) add(item);
        else if (!notes.some(n => n.id === item.id)) notes.push(item);
    }
    const resolved: Accounting['resolved'] = [];
    if (previousOpen) {
        const evidence = new Map(verdict.resolved_previous.filter(r => r?.id && r.evidence).map(r => [r.id, r.evidence]));
        for (const item of previousOpen) {
            if (evidence.has(item.id)) resolved.push({ item, evidence: evidence.get(item.id)! });
            else if (!seen.has(item.id)) {
                seen.add(item.id);
                open.push({ ...item, status: verdict.carried.includes(item.id) ? 'carried' : 'not accounted for' });
            }
        }
    }
    return { open, unverified, resolved, answerInReply, notes };
}

export function itemLine(item: OpenItem): string {
    const where = item.file ? ` ${item.file}${item.line ? `:${item.line}` : ''}` : '';
    const by = item.reviewer ? ` (${item.reviewer})` : '';
    const status = item.status ? `, ${item.status}` : '';
    return `[${item.class}${status}]${by}${where} ${item.issue}${item.consequence ? `\n      consequence: ${item.consequence}` : ''}${item.evidence ? `\n      ${item.evidence}` : ''}`;
}
