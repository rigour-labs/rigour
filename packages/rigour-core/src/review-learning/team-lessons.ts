/**
 * The team's review lessons that apply to a change, for the reviewer (an
 * agent or a model) to check before the PR: "your team has asked for this
 * before".
 */
import { parseDiff } from '../utils/diff.js';
import { matchLessons, readLessons, type ReviewLesson } from './lessons.js';

export type LessonMode = 'verified' | 'all' | 'off';

export function lessonsForDiff(cwd: string, diff: string, mode: LessonMode = 'off'): ReviewLesson[] {
    if (mode === 'off') return [];
    const lessons = readLessons(cwd);
    if (lessons.length === 0) return [];
    const files = Object.keys(parseDiff(diff));
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    const symbols = new Set(added.match(/[A-Za-z_$][\w$]{3,}/g) ?? []);
    return matchLessons(lessons, { files, symbols }, { includeCandidates: mode === 'all' });
}

export function lessonsSection(lessons: ReviewLesson[]): string {
    if (lessons.length === 0) return '';
    const lines = lessons.map(l => `- ${l.file}: ${l.text} (acted on in PR ${[...new Set(l.evidence.map(e => `#${e.pr}`))].join(', ')})`);
    return `TEAM LESSONS (this team asked for these in past reviews; check whether the change repeats any):\n${lines.join('\n')}`;
}
