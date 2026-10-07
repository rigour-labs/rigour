/**
 * The team's review lessons that apply to a change, for the reviewer (an
 * agent or a model) to check before the PR: "your team has asked for this
 * before".
 */
import { parseDiff } from '../utils/diff.js';
import { matchLessons, readLessons, type ReviewLesson } from './lessons.js';

export type LessonMode = 'verified' | 'all' | 'off';

/** Lessons a person or repeated evidence verified reach the reviewer unless a team turns them off. */
export const DEFAULT_LESSON_MODE: LessonMode = 'verified';

/** The team's review lessons in play for this mode: none when off, verified ones by default. */
export function activeLessons(cwd: string, mode: LessonMode = DEFAULT_LESSON_MODE): ReviewLesson[] {
    if (mode === 'off') return [];
    return readLessons(cwd).filter(l => mode === 'all' || l.state === 'verified');
}

/** `standards`: how many team standards may come with the file lessons (a judge reading a whole pull request takes more than an agent's one question). */
export function lessonsForDiff(cwd: string, diff: string, mode: LessonMode = DEFAULT_LESSON_MODE, standards?: number): ReviewLesson[] {
    if (mode === 'off') return [];
    const lessons = readLessons(cwd);
    if (lessons.length === 0) return [];
    return matchLessons(lessons, changeShape(diff), { includeCandidates: mode === 'all', ...(standards !== undefined ? { standards } : {}) });
}

/** The points this team rejected that a change touches: what the judges are told is settled. */
export function rejectedForDiff(cwd: string, diff: string): ReviewLesson[] {
    const rejected = readLessons(cwd).filter(l => l.state === 'rejected');
    if (rejected.length === 0) return [];
    const matched = new Set(matchLessons(rejected.map(l => ({ ...l, state: 'verified' as const })), changeShape(diff), { standards: 5 }).map(l => l.id));
    return rejected.filter(l => matched.has(l.id));
}

function changeShape(diff: string): { files: string[]; symbols: Set<string> } {
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    return { files: Object.keys(parseDiff(diff)), symbols: new Set(added.match(/[A-Za-z_$][\w$]{3,}/g) ?? []) };
}

/** A lesson as a judge or agent sees it, in one place. */
export interface LessonView { file: string; text: string; prs: number[]; said?: string }

export function lessonView(l: ReviewLesson): LessonView {
    const said = l.evidence.find(e => e.said && e.said !== l.text)?.said;
    return { file: l.file, text: l.text, prs: [...new Set(l.evidence.map(e => e.pr))], ...(said ? { said } : {}) };
}

/**
 * One line per lesson: where it applies, the rule, and, when a model wrote the rule from a person's
 * point, their own words, so anyone can see when the rule went beyond what was said.
 */
export function describeLesson(l: LessonView): string {
    const where = l.file ? `${l.file}: ` : 'team standard: ';
    const said = l.said ? ` (in their words: "${l.said}")` : '';
    const prs = l.prs.length ? ` (acted on in PR ${l.prs.map(p => `#${p}`).join(', ')})` : '';
    return `${where}${l.text}${said}${prs}`;
}

export function lessonsSection(lessons: ReviewLesson[]): string {
    if (lessons.length === 0) return '';
    const lines = lessons.map(l => `- ${describeLesson(lessonView(l))}`);
    return `TEAM LESSONS (this team asked for these in past reviews; check whether the change repeats any):\n${lines.join('\n')}`;
}
