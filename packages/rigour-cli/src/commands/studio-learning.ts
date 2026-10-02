/**
 * Studio's "How it learns": each lesson's path from where it was learned to whether the same
 * mistake still reaches a PR, and the weekly count of repeats stopped in development against
 * repeats that reached a PR.
 *
 * A repeat is a later catch of the same kind of defect as a fix lesson (same rule and title, the
 * lesson's subject prefix). Counts that Rigour cannot know here are null, never 0: PR catches
 * recorded on another machine (CI) never reach this one.
 */
import { fixLessonPrefix, listKnowledgeLessons, readLessons, type AgentEvent, type LessonRecord, type ReviewLesson, type Story } from '@rigour-labs/core';
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
}

export interface StudioLearning {
    lessons: LessonJourney[];
    weeks: Array<{ from: string; stoppedInDevelopment: number; reachedPr: number | null }>;
    prRecorded: boolean;
}

interface Catch { at: string; prefix: string }

export function buildLearning(input: { now: Date; lessons: LessonRecord[]; reviewLessons: ReviewLesson[]; stories: Story[]; events: AgentEvent[] }): StudioLearning {
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
        ...input.lessons.filter(l => l.kind === 'fix' || l.kind === 'memory').map(l => ({
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
            learnedFrom: `At PR ${[...new Set(l.evidence.map(e => `#${e.pr}`))].join(', ')}, from ${[...new Set(l.evidence.map(e => e.author))].join(', ')}`,
            learnedAt: l.createdAt,
            state: l.state,
            scope: 'this repo' as const,
            told: told(l.text),
            stoppedInDevelopment: null,
            reachedPr: null,
            canDecide: false,
        })),
    ].sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));

    const weeks = Array.from({ length: WEEKS }, (_, i) => {
        const end = input.now.getTime() - (WEEKS - 1 - i) * WEEK_MS;
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

export async function loadLearning(cwd: string, now = new Date()): Promise<StudioLearning> {
    const roots = checkoutRoots(cwd);
    return buildLearning({ now, lessons: await listKnowledgeLessons(cwd), reviewLessons: readLessons(cwd), stories: storiesAcross(roots), events: eventsAcross(roots) });
}

/** "Fixed before: Credential header follows redirects (semantic-bugs). The header…" → the defect, in words. */
function readableFixLesson(subject: string): string {
    const match = subject.match(/^Fixed before: (.*?) \([^)]*\)\.\s*(.*)$/);
    return match ? (match[2] ? `${match[1]}: ${match[2]}` : match[1]) : subject;
}

function fixOrigin(lesson: LessonRecord, stories: Story[]): string {
    const first = stories.find(s => lesson.subject.startsWith(fixLessonPrefix({ rule: s.rule, title: s.title })));
    const files = Array.isArray((lesson.evidence as { files?: unknown }).files) ? (lesson.evidence as { files: string[] }).files.length : 0;
    const where = first ? { edit: 'while an agent was writing', review: 'in an agent review', stop: 'as an agent tried to finish', pr: 'at a PR' }[first.stage] : 'in development';
    return `${files > 1 ? `${files} fixes` : 'A fix'} ${where}`;
}
