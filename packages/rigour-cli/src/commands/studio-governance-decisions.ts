/**
 * Governance decisions: one log of what people decided about Rigour here, newest first, from every place a decision
 * is kept: review lessons (accepted, rejected, reworded, scoped …), "not a bug" dismissals, reviewer findings
 * dismissed, compiled checks approved or withdrawn, commands a person approved or rejected in Studio, and the
 * decisions teammates shared. Who decided is shown only where the record names them; a "not a bug" dismissal and a
 * Studio approval record nobody.
 */
import path from 'path';
import { lessonsPath, type AgentEvent, type CompiledCheck, type LessonEvidence, type ReviewLesson, type TeamDecisionCache } from '@rigour-labs/core';
import type { Dismissal } from './studio-week.js';
import { readJsonFile } from './studio-threads.js';

export interface Decision {
    at: string;
    who: string | null;
    kind: string;
    text: string;
    reason: string | null;
    pr?: number;
    source: 'review lessons' | 'not a bug' | 'reviewer' | 'compiled checks' | 'Studio approval' | 'team';
}

export interface ReviewDismissal { file?: string; line?: number; class: string; issue: string; reason: string; at: string; by?: string }

export interface DecisionInputs {
    lessons: ReviewLesson[];
    dismissals: Dismissal[];
    reviewDismissals: ReviewDismissal[];
    compiled: CompiledCheck[];
    events: AgentEvent[];
    team?: TeamDecisionCache;
}

/** A person's decision on a lesson, as a team lead reads it. `compiled` is left to compiled-checks.json, which keeps more. */
const LESSON_KINDS: Record<string, string> = {
    accepted: 'Lesson accepted', rejected: 'Lesson rejected', 'not-a-rule': 'Not a rule', 'took-back': 'Decision taken back',
    dismissed: 'Evidence set aside', reworded: 'Lesson reworded', scoped: 'Lesson widened', compiled: 'Check approved or withdrawn',
};

/** Every decision, newest first. */
export function buildDecisions(input: DecisionInputs): Decision[] {
    const all = [
        ...lessonDecisions(input.lessons),
        ...input.dismissals.map(d => ({ at: d.at, who: null, kind: 'Not a bug', text: d.check ?? 'A finding (its check was not recorded)', reason: d.reason || null, source: 'not a bug' as const })),
        ...input.reviewDismissals.map(d => ({
            at: d.at, who: d.by || null, kind: 'Reviewer finding dismissed', text: `${d.issue}${d.file ? ` (${d.file}${d.line ? `:${d.line}` : ''})` : ''}`, reason: d.reason || null, source: 'reviewer' as const,
        })),
        ...compiledDecisions(input.compiled),
        ...arbitrations(input.events),
        ...teamDecisions(input.team, input.lessons),
    ];
    return all.filter(d => Number.isFinite(Date.parse(d.at))).sort((a, b) => b.at.localeCompare(a.at));
}

function lessonDecisions(lessons: ReviewLesson[]): Decision[] {
    return lessons.flatMap(lesson => lesson.evidence
        .filter((e): e is LessonEvidence & { at: string } => !!e.kind && e.kind !== 'compiled' && e.kind in LESSON_KINDS && typeof e.at === 'string')
        .map(e => ({ at: e.at, who: e.author || null, kind: LESSON_KINDS[e.kind!], text: lesson.text, reason: e.detail || null, ...(e.pr ? { pr: e.pr } : {}), source: 'review lessons' as const })));
}

function compiledDecisions(checks: CompiledCheck[]): Decision[] {
    return checks.flatMap(check => (check.history ?? []).map(h => ({
        at: h.at, who: h.by || null, kind: h.state === 'active' ? 'Check approved' : 'Check withdrawn', text: check.message, reason: null, source: 'compiled checks' as const,
    })));
}

/** A command an agent asked to run that a person approved or rejected in Studio, or that timed out unanswered. */
function arbitrations(events: AgentEvent[]): Decision[] {
    type Arbitration = AgentEvent & { requestId?: string; decision?: string; arbitrated?: boolean; command?: string };
    const all = events as Arbitration[];
    const commands = new Map(all.filter(e => e.requestId && typeof e.command === 'string').map(e => [e.requestId!, e.command!]));
    return all.filter(e => e.tool === 'human_arbitration' && e.timestamp && (e.arbitrated === true || e.decision === 'timeout-deny')).map(e => ({
        at: e.timestamp!,
        who: null,
        kind: e.decision === 'approve' ? 'Command approved' : e.decision === 'reject' ? 'Command rejected' : 'Command denied: nobody answered',
        text: commands.get(e.requestId ?? '') ?? 'A command an agent asked to run',
        reason: null,
        source: 'Studio approval' as const,
    }));
}

/** Decisions teammates shared; one this clone also holds in its own lessons is shown once, from there. */
function teamDecisions(cache: TeamDecisionCache | undefined, lessons: ReviewLesson[]): Decision[] {
    if (!cache) return [];
    const local = new Set(lessons.flatMap(l => l.evidence.map(e => `${l.id}\u0000${e.kind}\u0000${e.at}`)));
    const texts = new Map(lessons.map(l => [l.id, l.text]));
    return cache.decisions.filter(d => !local.has(`${d.lessonId}\u0000${d.kind}\u0000${d.decidedAt}`)).map(d => ({
        at: d.decidedAt,
        who: d.name ?? null,
        kind: LESSON_KINDS[d.kind] ?? d.kind,
        text: d.text ?? texts.get(d.lessonId) ?? 'A team lesson',
        reason: d.detail || null,
        ...(d.points[0]?.pr ? { pr: d.points[0].pr } : {}),
        source: 'team' as const,
    }));
}

/** The stored review lessons alone (the team's decisions are read from their own cache). */
export function readStoredReviewLessons(cwd: string): ReviewLesson[] {
    const parsed = readJsonFile<{ lessons?: ReviewLesson[] }>(lessonsPath(cwd));
    return Array.isArray(parsed?.lessons) ? parsed.lessons.filter(l => Array.isArray(l?.evidence)) : [];
}

export function readReviewDismissals(cwd: string): ReviewDismissal[] {
    const parsed = readJsonFile<{ entries?: ReviewDismissal[] }>(path.join(cwd, '.rigour', 'dismissed-review-items.json'));
    return Array.isArray(parsed?.entries) ? parsed.entries.filter(e => typeof e?.at === 'string') : [];
}
