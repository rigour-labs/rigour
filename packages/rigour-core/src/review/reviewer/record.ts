/**
 * The record of one review: what Rigour checked against the checkout, what it could only record as
 * reported, who decided what, and who judged, with an integrity hash so a copy can be checked against
 * the original. Nothing in it rests on a judge's word alone: every blocking or should-fix item here
 * passed the quote check, and every rule and lesson count comes from what Rigour served and the
 * answers it kept. The receipt a pull request carries is built from this.
 */
import { createHash } from 'crypto';
import type { Accounting, OpenItem, Verdict } from './verdict.js';

export interface ReviewRecord {
    version: 1;
    head: string;
    base: string;
    scope: 'full' | 'delta';
    at: string;
    /** `outside_repo`: what the judge also read from the machine's own config (a person's instructions); absent when it read only the repository and Rigour's inputs. */
    judges: Array<{ reviewer: string; version?: string; model?: string; cost_usd?: number; turns?: number; outside_repo?: string }>;
    /** Checked by Rigour against the checkout. */
    verified: {
        blocking: OpenItem[];
        should_fix: OpenItem[];
        /** The repository's own rules served to the judge, and its answers. */
        rules: { served: number; followed: number; broken: number; not_applicable: number };
        /** The team's lessons served, and how many the judge found the change repeats. */
        lessons: { served: number; applied: number };
        /** `labelled`: points that took the review's own severity heading; `relabelled`: of those, the ones the judge had read otherwise. */
        prior_points: { open: number; resolved: number; answer_in_reply: number; labelled?: number; relabelled?: number };
        unverified: number;
        notes: number;
        disputed: number;
    };
    /** Recorded as reported, not checked by Rigour. */
    reported: { human_reviews: number };
    /** Reviewed without pull request context: no pull request, description or human review was read (`--blind`). */
    blind?: true;
    /** Decisions people made. */
    people: { dismissed: number };
    /** sha256 of everything above, keys sorted, so a copy can be checked against the original. */
    integrity: string;
}

export interface RecordInput {
    head: string;
    base: string;
    scope: 'full' | 'delta';
    verdict: Verdict;
    accounted: Accounting & { disputed: OpenItem[]; dismissed: OpenItem[] };
    judges: ReviewRecord['judges'];
    lessonsServed: number;
    humanReviews: number;
    at?: string;
    /** Reviewed without pull request context (`--blind`). */
    blind?: boolean;
}

export function buildRecord(input: RecordInput): ReviewRecord {
    const rules = input.verdict.rules ?? [];
    const lessons = input.verdict.lessons ?? [];
    const body: Omit<ReviewRecord, 'integrity'> = {
        version: 1,
        head: input.head,
        base: input.base,
        scope: input.scope,
        at: input.at ?? new Date().toISOString(),
        judges: input.judges,
        verified: {
            blocking: input.accounted.open,
            should_fix: input.accounted.advisory,
            rules: { served: rules.length, followed: rules.filter(r => r.status === 'followed').length, broken: rules.filter(r => r.status === 'broken').length, not_applicable: rules.filter(r => r.status === 'not-applicable').length },
            lessons: { served: input.lessonsServed, applied: lessons.filter(l => l.applies === true).length },
            prior_points: { open: input.accounted.open.filter(i => i.kind === 'prior').length, resolved: input.accounted.resolved.length, answer_in_reply: input.accounted.answerInReply.length, ...(input.accounted.labels?.served ? { labelled: input.accounted.labels.taken, relabelled: input.accounted.labels.disagreed } : {}) },
            unverified: input.accounted.unverified.length,
            notes: input.accounted.notes.length,
            disputed: input.accounted.disputed.length,
        },
        reported: { human_reviews: input.humanReviews },
        people: { dismissed: input.accounted.dismissed.length },
        ...(input.blind ? { blind: true as const } : {}),
    };
    return { ...body, integrity: integrityOf(body) };
}

/** The hash a record's integrity field must equal; a record whose hash differs was changed after Rigour wrote it. */
export function integrityOf(body: Omit<ReviewRecord, 'integrity'>): string {
    return createHash('sha256').update(canonical(body)).digest('hex');
}

/** Checks that a record's contents hash to its integrity field. */
export function recordIntact(record: ReviewRecord): boolean {
    const { integrity, ...body } = record;
    return integrityOf(body) === integrity;
}

/** JSON with every object's keys sorted and, as JSON itself does, no undefined members: a record read back from disk hashes the same. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(v => canonical(v === undefined ? null : v)).join(',')}]`;
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** The record as a pull request summary shows it: blocks in full, a few should-fixes, the counts, the judges, the hash. */
export function recordLines(r: ReviewRecord, shouldFixShown = 5): string[] {
    const where = (i: OpenItem) => `${i.file ? `\`${i.file}${i.line ? `:${i.line}` : ''}\` ` : ''}${i.issue}${i.locations?.length ? ` (also ${i.locations.map(l => `\`${l.file}${l.line ? `:${l.line}` : ''}\``).join(', ')})` : ''}`;
    const v = r.verified;
    const lines = [`**Review record** · ${v.blocking.length} blocking · ${v.should_fix.length} should-fix · rules ${v.rules.followed} followed, ${v.rules.broken} broken, ${v.rules.not_applicable} not applicable of ${v.rules.served} · lessons ${v.lessons.applied} of ${v.lessons.served} apply · prior points ${v.prior_points.open} open, ${v.prior_points.resolved} resolved${v.prior_points.labelled !== undefined ? `, ${v.prior_points.labelled} by the review's own label (${v.prior_points.relabelled} relabelled)` : ''}`];
    for (const i of v.blocking) lines.push(`- **Blocking** ${where(i)}`);
    for (const i of v.should_fix.slice(0, shouldFixShown)) lines.push(`- Should fix: ${where(i)}`);
    if (v.should_fix.length > shouldFixShown) lines.push(`- …and ${v.should_fix.length - shouldFixShown} more should-fix in the record.`);
    const folded = [[v.notes, 'working note'], [v.disputed, 'disputed'], [v.unverified, 'unverified'], [r.people.dismissed, 'dismissed']].filter(([n]) => (n as number) > 0) as Array<[number, string]>;
    if (folded.length) lines.push(`Also seen, never blocking: ${folded.map(([n, w]) => `${n} ${w}${n === 1 || w === 'disputed' || w === 'unverified' || w === 'dismissed' ? '' : 's'}`).join(', ')}.`);
    lines.push(`Judged by ${r.judges.map(j => `${j.reviewer}${j.version ? ` ${j.version}` : ''}${j.model ? ` (${j.model})` : ''}${typeof j.cost_usd === 'number' ? ` $${j.cost_usd.toFixed(2)}` : ''}${j.outside_repo ? ` [${j.outside_repo}]` : ''}`).join(', ') || 'no judge'} on \`${r.head.slice(0, 9)}\` against \`${r.base.slice(0, 9)}\` (${r.scope}); ${r.blind ? 'reviewed without pull request context' : `${r.reported.human_reviews} human review(s) seen`}. Integrity \`${r.integrity.slice(0, 16)}\`.`);
    return lines;
}
