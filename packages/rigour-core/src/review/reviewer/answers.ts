/**
 * The judge's answers a readiness verdict reads (readiness.ts), from the verdict as the judge gave it: each goal item's
 * answer with whether its quote is the code at the line it names (the check every quote gets), and how many distinct
 * team lessons it answered as repeated or not. With a panel the judges' answers are all kept, so each can be weighed.
 */
import { createHash } from 'crypto';
import { parseGoal } from '../../goal/goal.js';
import type { Verdict, Verify } from './verdict.js';

export interface GoalAnswer {
    item: string;
    met: boolean | null;
    /** The answer named a file and line whose code is the quote it gave. */
    checked: boolean;
}

export interface LessonAnswers {
    /** Distinct lessons a judge said this change repeats. */
    repeated: number;
    /** Distinct lessons judged not repeated, and by no judge repeated. */
    notRepeated: number;
}

export function goalAnswers(goal: NonNullable<Verdict['goal']>, verify: Verify): GoalAnswer[] {
    return goal.map(g => ({ item: g.item, met: g.met, checked: !!g.file && !!g.quote?.trim() && verify(g.file, g.line, g.quote) }));
}

export function lessonAnswers(lessons: NonNullable<Verdict['lessons']>): LessonAnswers {
    const repeated = new Set(lessons.filter(l => l.applies === true).map(l => l.lesson));
    const notRepeated = new Set(lessons.filter(l => l.applies === false && !repeated.has(l.lesson)).map(l => l.lesson));
    return { repeated: repeated.size, notRepeated: notRepeated.size };
}

/** The pull request's description as a hash, line endings and outer whitespace aside: what a stored verdict was built from. */
export function descriptionHash(body: string): string {
    return createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/** The description's acceptance criteria: each "Done when" item and the files it names. */
export function acceptanceCriteria(description: string): Array<{ text: string; paths: string[] }> {
    return parseGoal(description).doneWhen.map(item => ({ text: item.text, paths: item.paths }));
}
