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
import fs from 'fs';
import path from 'path';
import type { RunTrace, Spend, Tokens } from './adapters.js';
import type { PanelItem } from './panel.js';
import { textSimilarity } from './consensus.js';

export interface PriorPoint { point: string; review?: string; severity?: 'blocking' | 'should-fix' | 'non-blocking'; resolved: boolean; evidence?: string; checked_siblings?: string[]; reviewer?: string; file?: string; line?: number; quote?: string }
interface Redundant { file: string; line?: number; what: string; made_redundant_by?: string; removed: boolean; reviewer?: string }
interface Read { file: string; line?: number; read: string; rules?: Array<{ rule: string; known_before_read: boolean; applied_before_read: boolean }>; narrower_source?: string | null; keys?: Key[]; window_bounded?: boolean | null; keyset?: boolean | null; reviewer?: string }
interface Scan { file: string; line?: number; function: string; outer: string; inner: string; fix: string; reviewer?: string }
interface MergeImpactItem { symbol: string; main_file: string; call_site: string; holds: boolean; why: string; reviewer?: string }
interface Key { name: string; inputs: string; stable_under_edit: boolean }
interface JourneyItem { file: string; line?: number; what: string; cleared_by?: string | null; retry_safe?: boolean | null; overlap_safe?: boolean | null; can_move_back?: boolean | null; keys?: Key[]; reviewer?: string }
interface Sibling { changed: string; sibling: string; needs_same_change: boolean; has_it: boolean; why?: string; reviewer?: string }
interface Claim { source: 'comment' | 'description'; claim: string; file?: string; line?: number; holds: boolean; evidence?: string; reviewer?: string }
/** The judge's answer for one team lesson it was shown: does this change repeat it. */
interface LessonCheck { lesson: string; applies: boolean; file?: string; line?: number; evidence?: string; reviewer?: string }
export interface Finding { class: string; file: string; line?: number; issue: string; why?: string; consequence?: string; input?: string; quote?: string; reviewer?: string; severity?: 'blocking' | 'should'; absent?: string }

export interface Verdict {
    prior_points: PriorPoint[];
    redundant: Redundant[];
    reads: Read[];
    scans: Scan[];
    merge_impact: MergeImpactItem[];
    /** Optional: a verdict cached before these steps existed has none. */
    journey?: JourneyItem[];
    siblings?: Sibling[];
    claims?: Claim[];
    lessons?: LessonCheck[];
    findings: Finding[];
    carried: string[];
    resolved_previous: Array<{ id: string; evidence: string }>;
    reviewer?: string;
    cost_usd?: number;
    tokens?: Tokens;
    /** Where the run's tokens went and what it read (measurement only). */
    trace?: RunTrace;
    reviewers?: Array<{ reviewer: string; cost_usd?: number; tokens?: Tokens; trace?: RunTrace }>;
    /** With a panel: every judge's own item ids, and the panel's decision on each finding (reviewer/panel.ts). */
    panel?: { judgeItemIds: string[]; items: PanelItem[] };
}

export interface OpenItem {
    id: string;
    kind: 'prior' | 'redundant' | 'read' | 'scan' | 'merge' | 'journey' | 'sibling' | 'claim' | 'lesson' | 'finding';
    class: string;
    file?: string;
    line?: number;
    issue: string;
    evidence?: string;
    /** For a finding: the wrong outcome or the cost. A finding without one is a note, never a block. */
    consequence?: string;
    /** For a finding: the input that goes wrong, and the code it quotes at file:line (checked against the checkout). */
    input?: string;
    quote?: string;
    reviewer?: string;
    /** In delta mode, how the item reached this verdict. */
    status?: 'carried' | 'not accounted for';
}

/** Checks a file (and a line, and a quote of the code there) against the checkout; an item that fails cannot block. */
export type Verify = (file: string, line: number | undefined, quote?: string) => boolean;

/**
 * A file in the checkout, and a line it has: an item naming anything else is a reviewer's slip. With a quote, the
 * quoted code must also be there, within QUOTE_WINDOW lines of the line named (whitespace aside): a claim about code
 * that is not where the judge says it is never blocks, whichever model made it.
 */
export function checkoutVerifier(cwd: string): Verify {
    const files = new Map<string, string[] | undefined>();
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
    return (file, line, quote) => {
        if (!files.has(file)) {
            try {
                files.set(file, fs.readFileSync(path.join(cwd, file), 'utf8').split('\n'));
            } catch {
                files.set(file, undefined);
            }
        }
        const lines = files.get(file);
        if (!lines || (line !== undefined && line > lines.length)) return false;
        if (quote === undefined) return true;
        const wanted = squash(quote);
        if (!wanted) return false;
        const span = quote.split('\n').length;
        const from = line === undefined ? 0 : Math.max(0, line - 1 - QUOTE_WINDOW);
        const to = line === undefined ? lines.length : line - 1 + span + QUOTE_WINDOW;
        return squash(lines.slice(from, to).join('\n')).includes(wanted);
    };
}

/** How far from the line it names a finding's quote may sit: judges count lines loosely. */
const QUOTE_WINDOW = 3;

/** How alike a finding and a point a human accepted as non-blocking must read to be that point again. */
const ACCEPTED_SIMILARITY = 0.4;

/** The reviewer's working steps: shown so a person can follow the reasoning, never a block on their own. */
const WORKING_NOTES = new Set<OpenItem['kind']>(['redundant', 'read', 'scan', 'merge', 'journey', 'sibling', 'claim', 'lesson']);

const SHAPE: Array<keyof Verdict> = ['prior_points', 'reads', 'findings'];
const LISTS: Array<keyof Verdict> = ['redundant', 'scans', 'merge_impact', 'journey', 'siblings', 'claims', 'lessons', 'carried', 'resolved_previous'];

/** The verdict in a reviewer's answer, or why it is not one. `needsPriorPoints`: a human review exists and none of its points is carried. */
export function parseVerdict(text: string, needsPriorPoints: boolean, reviewer: string, spend: Spend): { verdict: Verdict } | { error: string } {
    const parsed = verdictIn(text);
    if (!parsed || !SHAPE.every(key => Array.isArray(parsed[key]))) return { error: `${reviewer}: no valid verdict (${text.slice(0, 200).replace(/\s+/g, ' ')})` };
    if (needsPriorPoints && parsed.prior_points.length === 0) return { error: `${reviewer} did not report on the human reviews` };
    for (const key of LISTS) if (!Array.isArray(parsed[key])) parsed[key] = [];
    return { verdict: { ...parsed, reviewer, ...(spend.costUsd !== undefined ? { cost_usd: spend.costUsd } : {}), ...(spend.tokens ? { tokens: spend.tokens } : {}), ...(spend.trace ? { trace: spend.trace } : {}) } };
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
        journey: tagged(part => part.journey ?? []),
        siblings: tagged(part => part.siblings ?? []),
        claims: tagged(part => part.claims ?? []),
        lessons: tagged(part => part.lessons ?? []),
        findings: tagged(part => part.findings),
        carried: parts.flatMap(part => part.carried),
        resolved_previous: parts.length === 1 ? parts[0].resolved_previous : parts[0].resolved_previous.filter(x => parts.every(part => part.resolved_previous.some(y => y.id === x.id))),
        reviewers: parts.map(part => ({ reviewer: part.reviewer ?? '?', ...(part.cost_usd !== undefined ? { cost_usd: part.cost_usd } : {}), ...(part.tokens ? { tokens: part.tokens } : {}), ...(part.trace ? { trace: part.trace } : {}) })),
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
    const notes: OpenItem[] = [];
    const seen = new Set<string>();
    const accepted = verdict.prior_points.filter(p => p.severity === 'non-blocking');
    // A prior point is the human's and needs no file. A finding blocks only when the code it quotes is at the line it
    // names: any model's claim is checked, never trusted. What the working steps turned up is a note: the reasoning,
    // shown, and a block only when the judge also makes it a finding it can quote.
    const add = (item: OpenItem) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        if (WORKING_NOTES.has(item.kind)) return void notes.push(item);
        const placed = !!item.file && !!item.quote?.trim() && verify(item.file, item.line, item.quote);
        (placed ? open : unverified).push(item);
    };
    const answerInReply: PriorPoint[] = [];
    for (const p of verdict.prior_points) {
        if (p.resolved) continue;
        if (p.severity === 'non-blocking') answerInReply.push(p);
        // Still open only where the judge quotes the code that keeps it open: a point a later commit already fixed never blocks.
        else add({ id: id('prior', p.review, p.point), kind: 'prior', class: 'prior point', issue: p.point, evidence: p.evidence, reviewer: p.reviewer, ...(p.file ? { file: p.file } : {}), ...(p.line ? { line: p.line } : {}), ...(p.quote ? { quote: p.quote } : {}) });
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
    for (const j of verdict.journey ?? []) {
        const problems = [
            ...(j.retry_safe === false ? ['a retry of the same request leaves it wrong'] : []),
            ...(j.overlap_safe === false ? ['two overlapping runs leave it wrong'] : []),
            ...(j.can_move_back === true ? ['can move a record back to an earlier status'] : []),
            ...(j.keys ?? []).filter(k => k.stable_under_edit === false).map(k => `key ${k.name} changes when the user edits: ${k.inputs}`),
        ];
        for (const text of problems) add({ id: id('correctness', j.file, j.what, text), kind: 'journey', class: 'correctness', file: j.file, line: j.line, issue: `${j.what}: ${text}`, reviewer: j.reviewer });
    }
    for (const sib of verdict.siblings ?? []) {
        if (!sib.needs_same_change || sib.has_it) continue;
        const [file, line] = sib.sibling.split(':');
        add({ id: id('correctness', sib.sibling, sib.changed), kind: 'sibling', class: 'correctness', file, line: Number(line) || undefined, issue: `needs the same change as ${sib.changed}${sib.why ? `: ${sib.why}` : ''}`, reviewer: sib.reviewer });
    }
    for (const c of verdict.claims ?? []) {
        if (c.holds !== false) continue;
        add({ id: id('stale-claim', c.file, c.claim), kind: 'claim', class: 'stale-claim', file: c.file, line: c.line, issue: `the ${c.source} says "${c.claim}", and the code no longer does that`, evidence: c.evidence, reviewer: c.reviewer });
    }
    // A team lesson the change repeats: shown with the code, never a block on its own (the judge's finding, quoted, is).
    for (const l of verdict.lessons ?? []) {
        if (l.applies !== true) continue;
        add({ id: id('team-lesson', l.file, l.lesson), kind: 'lesson', class: 'team-lesson', file: l.file, line: l.line, issue: `repeats a team lesson: ${l.lesson}`, evidence: l.evidence, reviewer: l.reviewer });
    }
    const stillOpen = new Set((previousOpen ?? []).map(item => item.id));
    for (const f of verdict.findings) {
        const item: OpenItem = { id: id(f.class, f.file, f.issue), kind: 'finding', class: f.class, file: f.file, line: f.line, issue: f.issue, evidence: f.why, ...(f.consequence?.trim() ? { consequence: f.consequence.trim() } : {}), ...(f.input?.trim() ? { input: f.input.trim() } : {}), ...(f.quote?.trim() ? { quote: f.quote } : {}), reviewer: f.reviewer };
        // An opinion is a finding the judge said has no consequence: an empty one. A missing field fails closed, and an
        // item already open from the last round stays open until it is resolved with evidence.
        const opinion = typeof f.consequence === 'string' && !f.consequence.trim() && !stillOpen.has(item.id);
        // Narrower than blocking by the judge's own severity, or a point a human already raised and accepted: shown, never a block.
        const should = f.severity === 'should' || accepted.some(p => textSimilarity(item, { id: '', kind: 'prior', class: item.class, issue: p.point }) >= ACCEPTED_SIMILARITY);
        // A claim that something is missing, about something the file has.
        const present = !!f.absent?.trim() && !!f.file && verify(f.file, undefined, f.absent);
        if (present) {
            if (!seen.has(item.id)) unverified.push(item);
            seen.add(item.id);
        } else if (!opinion && !should) add(item);
        else if (!notes.some(n => n.id === item.id)) notes.push(item);
    }
    const resolved: Accounting['resolved'] = [];
    if (previousOpen) {
        const evidence = new Map(verdict.resolved_previous.filter(r => r?.id && r.evidence).map(r => [r.id, r.evidence]));
        for (const item of previousOpen) {
            if (evidence.has(item.id)) resolved.push({ item, evidence: evidence.get(item.id)! });
            else if (WORKING_NOTES.has(item.kind)) {
                // Open under the earlier rule that blocked on working notes: a note now, never carried as a block.
                if (!seen.has(item.id)) notes.push(item);
                seen.add(item.id);
            } else if (!seen.has(item.id)) {
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
    return `[${item.class}${status}]${by}${where} ${item.issue}${item.input ? `\n      input: ${item.input}` : ''}${item.consequence ? `\n      consequence: ${item.consequence}` : ''}${item.quote ? `\n      code: ${item.quote.trim().split('\n')[0].slice(0, 160)}` : ''}${item.evidence ? `\n      ${item.evidence}` : ''}`;
}
