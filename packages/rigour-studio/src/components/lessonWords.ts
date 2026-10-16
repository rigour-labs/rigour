/** Where a lesson stands and where it came from, in the same plain words wherever Studio lists one. */
import { ago } from './storyData';
import type { ItemState } from './ui';
import type { Journey } from './LearningParts';

const IN_FORCE = new Set(['validated', 'promoted', 'verified']);

/** The Lessons tab's three piles: waiting for a person, in force, and taken back or dropped. */
export type LessonBucket = 'waiting' | 'force' | 'gone';

export function lessonBucket(lesson: Journey): LessonBucket {
    if (lesson.canDecide || lesson.state === 'candidate') return 'waiting';
    return IN_FORCE.has(lesson.state) ? 'force' : 'gone';
}

/** The one state chip a lesson carries. */
export function lessonState(lesson: Journey): ItemState {
    const bucket = lessonBucket(lesson);
    if (bucket === 'waiting') return 'waiting';
    if (bucket === 'force') return lesson.scope === 'team' ? 'team' : lesson.origin === 'pr' ? 'repo' : 'machine';
    return lesson.state === 'superseded' ? 'replaced' : 'dropped';
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Who told an agent to remember it: you, the teammate who proposed it, or an agent. */
export function toldBy(lesson: Journey): string {
    return lesson.yours ? 'you' : lesson.proposedBy ?? 'an agent';
}

/** Where a lesson came from and when, as one short line: "told to remember by dev-a · 2 h ago". */
export function originNote(lesson: Journey, now = Date.now()): string {
    const from = lesson.origin === 'memory' ? `told to remember by ${toldBy(lesson)}`
        : lesson.origin === 'pr' ? `learned ${lowerFirst(lesson.learnedFrom)}`
            : `learned from ${lowerFirst(lesson.learnedFrom)}`;
    const when = lesson.learnedAt ? ago(lesson.learnedAt, now) : '';
    return [from, when, lesson.sharedBy ? `shared by ${lesson.sharedBy}` : ''].filter(Boolean).join(' · ');
}

/** null means unknown on this machine. */
export const timesTold = (n: number | null) => (n === null ? 'not recorded here' : n === 1 ? '1 time' : `${n} times`);

/** Everything a search over a lesson looks at: its text, its memory key and value, and who proposed or shared it. */
export function lessonSearchText(lesson: Journey): string {
    return [lesson.text, lesson.memory?.key, lesson.memory?.value, lesson.proposedBy, lesson.sharedBy, lesson.learnedFrom].filter(Boolean).join(' ');
}
