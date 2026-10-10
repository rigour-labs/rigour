/**
 * Studio's "How it learns": each lesson's path from where it was learned to whether the same
 * mistake still reaches a PR, and the weekly count of repeats stopped in development against
 * repeats that reached a PR.
 *
 * A repeat is a later catch of the same kind of defect as a fix lesson (same rule and title, the
 * lesson's subject prefix). Counts that Rigour cannot know here are null, never 0: PR catches
 * recorded on another machine (CI) never reach this one.
 */
import { acceptSuggestedText, scopeLesson, decideCompiledCheck, decideLesson, fixLessonPrefix, proposeCompiledChecks, readCompiledChecks, suspension, type CompiledCheck, localOutcomeMetrics, pendingDecision, quietBotCandidate, type OutcomeMetrics, listKnowledgeLessons, readLessons, lastDecision, readTeamDecisionCache, type TeamDecisionCache, type AgentEvent, type LessonRecord, type ReviewLesson, type Story } from '@rigour-labs/core';
import { decider } from './git-identity.js';
import { checkoutRoots, eventsAcross, storiesAcross } from './studio-checkouts.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKS = 4;

export interface LessonJourney {
    id: string;
    text: string;
    /** development: from fixes agents made; pr: from review comments; memory: told by a person or agent. */
    origin: 'development' | 'pr' | 'memory';
    learnedFrom: string;
    learnedAt: string;
    state: string;
    scope: 'this repo' | 'personal' | 'team';
    told: number;
    stoppedInDevelopment: number | null;
    reachedPr: number | null;
    canDecide: boolean;
    /** A review lesson evidence took back (review-learning/outcome-evidence.ts): why, and the pull requests that did. A person may promote it again. */
    takenBack?: { detail: string; prs: number[]; at: string };
    /** A later fix changed the point's own lines (review-learning/outcome-evidence.ts): evidence for a person to promote or dismiss, never a promotion on its own. */
    suggested?: { detail: string; pr: number; at: string };
    /** Back to a candidate when outcomes stopped promoting: why, and the evidence that had promoted it, for a person to promote again or dismiss. */
    reclassified?: { detail: string; evidence: string[] };
    /** A corrected wording for a review lesson a person decided, waiting for them (core acceptSuggestedText). */
    suggestedText?: { text: string; why: string };
    /** How far a review lesson reaches (core scopeLesson): its file, its folder, or every change; `hasFile` false for a team standard. */
    reach?: { scope: 'file' | 'folder' | 'repo'; hasFile: boolean };
    /** A candidate only review bots raised, nothing waiting on a person (core quietBotCandidate): hidden until a person asks to see bot points. */
    fromBots?: true;
    /**
     * Teammates' decisions on a review lesson, received from the team database (core team-decisions.ts): each with the
     * teammate's display name and when the team database got it; and, when a later team decision settled the lesson
     * against this person's own, both, with why this machine does not share theirs (`yoursOnly`) when it does not.
     */
    team?: {
        decisions: Array<{ kind: string; name: string; at: string; detail?: string }>;
        overruled?: { yours: string; team: { kind: string; name: string; at: string }; yoursOnly?: string };
    };
}

export interface StudioLearning {
    lessons: LessonJourney[];
    weeks: Array<{ from: string; stoppedInDevelopment: number; reachedPr: number | null }>;
    prRecorded: boolean;
    /** What happened after merges this checkout read (core outcomes/metrics.ts); absent before `rigour outcomes` has run. */
    outcomes?: OutcomeMetrics;
    /** Lessons compiled into checks (core review-learning/compiled-lessons.ts), for a person to approve or take back; `suspended` says why one approved no longer runs. */
    compiled?: Array<CompiledCheck & { suspended?: string }>;
}

interface Catch { at: string; prefix: string }

export function buildLearning(input: { now: Date; lessons: LessonRecord[]; reviewLessons: ReviewLesson[]; stories: Story[]; events: AgentEvent[]; weeks?: number }): StudioLearning {
    const served = input.events.filter(e => e.type === 'lessons_served');
    const prEvents = input.events.filter(e => e.type === 'pr_catches');
    const prRecorded = prEvents.length > 0;
    const devCatches: Catch[] = input.stories.filter(s => s.stage !== 'pr').map(s => ({ at: s.at, prefix: fixLessonPrefix({ rule: s.rule, title: s.title }) }));
    const prCatches: Catch[] = prEvents.flatMap(e => (e.findings ?? []).map(f => ({ at: e.timestamp ?? '', prefix: fixLessonPrefix({ rule: f.rule, title: f.title }) })));
    const told = (text: string) => served.filter(e => e.lessons?.includes(text)).length;

    const fixLessons = input.lessons.filter(l => l.kind === 'fix');
    const learnedAt = (l: LessonRecord) => new Date(l.createdAt).toISOString();
    const isRepeat = (c: Catch) => fixLessons.some(l => c.prefix && l.subject.startsWith(c.prefix) && learnedAt(l) < c.at);
    const repeatsOf = (l: LessonRecord, catches: Catch[]) => catches.filter(c => l.subject.startsWith(c.prefix) && c.at > learnedAt(l)).length;

    const lessons: LessonJourney[] = [
        ...input.lessons.filter(l => (l.kind === 'fix' || l.kind === 'memory') && l.state !== 'rejected' && l.state !== 'superseded').map(l => ({
            id: l.id,
            text: l.kind === 'fix' ? readableFixLesson(l.subject) : l.subject,
            origin: l.kind === 'fix' ? 'development' as const : 'memory' as const,
            learnedFrom: l.kind === 'fix' ? fixOrigin(l, input.stories) : 'Told by a person or an agent',
            learnedAt: learnedAt(l),
            state: l.state,
            scope: l.visibility === 'team' ? 'team' as const : l.visibility === 'personal' ? 'personal' as const : 'this repo' as const,
            told: told(l.subject),
            stoppedInDevelopment: l.kind === 'fix' ? repeatsOf(l, devCatches) : null,
            reachedPr: l.kind === 'fix' && prRecorded ? repeatsOf(l, prCatches) : null,
            canDecide: l.state === 'candidate',
        })),
        ...input.reviewLessons.map(l => ({
            id: l.id,
            text: l.text,
            origin: 'pr' as const,
            // Where it was learned: the review points, not the outcome or decision evidence added since.
            learnedFrom: learnedFromPoints(l.evidence.filter(e => (e.kind ?? 'point') === 'point')),
            learnedAt: l.createdAt,
            state: l.state,
            scope: 'this repo' as const,
            told: told(l.text),
            stoppedInDevelopment: null,
            reachedPr: null,
            ...decisionFor(l),
            ...(l.suggestedText ? { suggestedText: { text: l.suggestedText, why: l.suggestedWhy ?? 'reworded' } } : {}),
            reach: { scope: l.scope ?? ('file' as const), hasFile: !!l.file },
            ...(quietBotCandidate(l) ? { fromBots: true as const } : {}),
        })),
    // Lessons back to a candidate when outcomes stopped promoting come first: a person decides each once.
    ].sort((a: LessonJourney, b: LessonJourney) => Number(!!b.reclassified) - Number(!!a.reclassified) || b.learnedAt.localeCompare(a.learnedAt))
        // The same lesson learned in several places (this repo and personal lessons from others) shows once.
        .filter((lesson, i, all) => all.findIndex(other => other.text === lesson.text) === i);

    const count = input.weeks ?? WEEKS;
    const weeks = Array.from({ length: count }, (_, i) => {
        const end = input.now.getTime() - (count - 1 - i) * WEEK_MS;
        const start = end - WEEK_MS;
        const within = (c: Catch) => Date.parse(c.at) > start && Date.parse(c.at) <= end;
        return {
            from: new Date(start).toISOString(),
            stoppedInDevelopment: devCatches.filter(c => within(c) && isRepeat(c)).length,
            reachedPr: prRecorded ? prCatches.filter(c => within(c) && isRepeat(c)).length : null,
        };
    });
    return { lessons, weeks, prRecorded };
}

/** A review lesson's team decisions for Studio, and whether a later one settled it against this person's own. */
function teamOn(lesson: ReviewLesson, sharing: TeamDecisionCache['sharing'] | undefined): Pick<LessonJourney, 'team'> {
    const decisions = lesson.evidence.filter(e => e.team).map(e => ({ kind: e.kind ?? 'point', name: e.team!.name, at: e.team!.receivedAt, ...(e.detail ? { detail: e.detail } : {}) }));
    if (decisions.length === 0) return {};
    const settled = lastDecision(lesson);
    const yours = lesson.evidence.filter(e => !e.team && e.author && (e.kind === 'accepted' || e.kind === 'rejected')).at(-1);
    const overruled = settled?.team && yours?.kind && yours.kind !== settled.kind
        ? { yours: yours.kind, team: { kind: settled.kind ?? 'accepted', name: settled.team.name, at: settled.team.receivedAt }, ...(sharing && !sharing.shares && sharing.reason ? { yoursOnly: sharing.reason } : {}) }
        : undefined;
    return { team: { decisions, ...(overruled ? { overruled } : {}) } };
}

function learnedFromPoints(points: ReviewLesson['evidence']): string {
    const authors = [...new Set(points.map(e => e.author).filter(Boolean))];
    return `At PR ${[...new Set(points.map(e => `#${e.pr}`))].join(', ')}${authors.length ? `, from ${authors.join(', ')}` : ''}`;
}

/**
 * What a person can decide on a review lesson, from the last of its evidence and decisions: taken back by evidence
 * (promote it again, or drop it), back to a candidate when outcomes stopped promoting (promote it again, or dismiss),
 * or a candidate with a later fix on its lines (promote it, or dismiss the evidence).
 */
function decisionFor(lesson: ReviewLesson): Pick<LessonJourney, 'canDecide' | 'takenBack' | 'suggested' | 'reclassified'> {
    const last = pendingDecision(lesson);
    if (last?.kind === 'reclassified') return { canDecide: true, reclassified: { detail: last.detail ?? '', evidence: lesson.evidence.filter(e => e.kind === 'outcome' || e.kind === 'lines').map(e => e.detail ?? '').filter(Boolean) } };
    if (last?.kind === 'demoted') return { canDecide: true, takenBack: { detail: last.detail ?? '', prs: lesson.evidence.filter(e => e.kind === 'against').map(e => e.pr), at: last.at ?? '' } };
    if (last?.kind === 'lines') return { canDecide: true, suggested: { detail: last.detail ?? '', pr: last.pr, at: last.at ?? '' } };
    return { canDecide: false };
}

/** The reason a person gave in Studio, else that they decided there. */
function studioWhy(why: unknown): string {
    return typeof why === 'string' && why.trim() ? why.trim() : 'decided in Studio';
}

/** A person's decision on a review lesson from Studio, recorded as `rigour learn-reviews --promote / --reject` records it: with their git email, and final. */
export function decideReviewLesson(cwd: string, body: unknown): { id: string; state: string } {
    const { id, decision, why } = (body ?? {}) as { id?: unknown; decision?: unknown; why?: unknown };
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw new Error('a review lesson id (12 hex characters) is required');
    if (decision === 'reworded') return rewordFromStudio(cwd, id);
    if (decision === 'scope') return scopeFromStudio(cwd, id, (body as { to?: unknown }).to, why);
    if (decision !== 'accepted' && decision !== 'rejected' && decision !== 'dismissed') throw new Error('decision is accepted, rejected, dismissed, reworded or scope');
    const lesson = decideLesson(cwd, id, decision, decider(cwd), studioWhy(why));
    if (!lesson) throw new Error(`no review lesson ${id}`);
    return { id: lesson.id, state: lesson.state };
}

/**
 * A person sets how far a review lesson reaches from Studio, as `rigour learn-reviews --scope` records it: with their
 * git email, so with no git email set it is refused, like a compiled check's decision.
 */
function scopeFromStudio(cwd: string, id: string, to: unknown, why: unknown): { id: string; state: string } {
    if (to !== 'file' && to !== 'folder' && to !== 'repo') throw new Error('to is file, folder or repo');
    const lesson = scopeLesson(cwd, id, to, decider(cwd), studioWhy(why));
    if (!lesson) throw new Error(`no review lesson ${id}`);
    return { id: lesson.id, state: lesson.state };
}

/** A person takes a decided lesson's suggested wording from Studio, recorded as `--use-wording` records it. */
function rewordFromStudio(cwd: string, id: string): { id: string; state: string } {
    const lesson = acceptSuggestedText(cwd, id, decider(cwd));
    if (!lesson) throw new Error(`no review lesson ${id} with a suggested wording`);
    return { id: lesson.id, state: lesson.state };
}

/**
 * A person's decision on a compiled check from Studio, as `rigour learn-reviews --approve-check / --withdraw-check`
 * records it: with their git email, committed with the check. With no git email set, it is refused.
 */
export function decideCompiledCheckFromStudio(cwd: string, body: unknown): CompiledCheck {
    const { id, state } = (body ?? {}) as { id?: unknown; state?: unknown };
    if (typeof id !== 'string' || !/^c-[\w-]+$/.test(id)) throw new Error('a compiled check id is required');
    if (state !== 'active' && state !== 'withdrawn') throw new Error('state is active or withdrawn');
    const by = decider(cwd);
    const check = decideCompiledCheck(cwd, id, state, by);
    if (!check) throw new Error(`no compiled check ${id}`);
    return check;
}

/** Proposes checks for the verified lessons a template fits, each backtested on the main branch's history. */
export function proposeChecksFromStudio(cwd: string): { proposed: number } {
    return { proposed: proposeCompiledChecks(cwd).length };
}

export async function loadLearning(cwd: string, now = new Date(), weeks = WEEKS): Promise<StudioLearning> {
    const roots = checkoutRoots(cwd);
    const reviewLessons = readLessons(cwd);
    const built = buildLearning({ now, lessons: await listKnowledgeLessons(cwd), reviewLessons, stories: storiesAcross(roots), events: eventsAcross(roots), weeks });
    // Teammates' decisions (team database), with why this machine does not share its person's when it does not.
    const sharing = readTeamDecisionCache(cwd)?.sharing;
    const byId = new Map(reviewLessons.map(l => [l.id, l]));
    const learning = { ...built, lessons: built.lessons.map(j => (byId.has(j.id) ? { ...j, ...teamOn(byId.get(j.id)!, sharing) } : j)) };
    const outcomes = localOutcomeMetrics(cwd);
    const withChecks = { ...learning, compiled: readCompiledChecks(cwd).map(c => ({ ...c, ...(suspension(c, byId) ? { suspended: suspension(c, byId) } : {}) })) };
    return outcomes ? { ...withChecks, outcomes } : withChecks;
}

/**
 * "Fixed before: Credential header follows redirects (semantic-bugs). The header…" → the defect,
 * in words. A title that is a shortened start of the detail is dropped for the detail, and a
 * leading "[rule-id]" tag is not shown.
 */
export function readableFixLesson(subject: string): string {
    const match = subject.match(/^Fixed before: (.*?) \([^)]*\)\.\s*([\s\S]*)$/);
    if (!match) return subject;
    const untag = (text: string) => text.replace(/^\[[\w-]+\]\s*/, '').trim();
    const title = untag(match[1]);
    const detail = untag(match[2]);
    if (!detail || detail.replace(/\.$/, '') === title) return title;
    const stem = title.replace(/(…|\.\.\.)[`'"]*$/, '').trim();
    return detail.startsWith(stem) ? detail.replace(/\.$/, '') : `${title}: ${detail}`;
}

function fixOrigin(lesson: LessonRecord, stories: Story[]): string {
    const first = stories.find(s => lesson.subject.startsWith(fixLessonPrefix({ rule: s.rule, title: s.title })));
    const files = Array.isArray((lesson.evidence as { files?: unknown }).files) ? (lesson.evidence as { files: string[] }).files.length : 0;
    const where = first ? { edit: 'while an agent was writing', review: 'in an agent review', stop: 'as an agent tried to finish', pr: 'at a PR' }[first.stage] : 'in development';
    return `${files > 1 ? `${files} fixes` : 'A fix'} ${where}`;
}
