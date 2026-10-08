/**
 * Outcome evidence from git, free and deterministic: what happened to the lines a review point named
 * after the pull request merged. A point the pull request did not act on, whose lines a later commit
 * on main changed with a fix, was right (outcome). One whose lines shipped and stayed unchanged for the
 * whole window was not needed (counter). A revert of the pull request is an outcome for every point it
 * left unaddressed. With `until`, only history before it counts, so a backtest never sees the future.
 */
import type { Git } from './acted-on.js';
import { changedHunks, type Hunk } from './acted-on.js';
import type { LessonEvidence, ReviewLesson } from './lessons.js';

/** Commit subjects that say the commit fixed something. */
export const FIX = /\b(fix(e[sd])?|bug|hotfix|regression|revert|broke|broken)\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OutcomeOptions {
    /** The main branch the pull request merged into. */
    mainRef: string;
    /** Only history before this time (ISO); now when unset. */
    until?: string;
    /** How long unchanged lines must ship before that counts against the point. */
    windowDays?: number;
}

export interface MergedAt { number: number; mergeSha: string; mergedAt: string }

/** The outcome or counter evidence for an inline point the pull request did not act on, or undefined when there is none yet. */
export function outcomeFor(git: Git, lesson: ReviewLesson, pr: MergedAt, options: OutcomeOptions): LessonEvidence | undefined {
    const point = lesson.evidence.find(e => (e.kind ?? 'point') === 'point' && e.pr === pr.number);
    if (!point || point.actedOn || !lesson.at || !lesson.file || !pr.mergedAt) return undefined;
    let range = shift(changedHunks(git, lesson.at.commit, pr.mergeSha, lesson.file), [lesson.at.start, lesson.at.end]);
    if (!range) return undefined; // the pull request changed them after all
    const before = options.until ? [`--before=${options.until}`] : [];
    let commits: string[] = [];
    try {
        commits = git(['rev-list', '--reverse', '--first-parent', ...before, `${pr.mergeSha}..${options.mainRef}`, '--', lesson.file]).split('\n').filter(Boolean);
    } catch {
        return undefined;
    }
    for (const sha of commits) {
        const hunks = changedHunks(git, `${sha}^`, sha, lesson.file);
        const next = shift(hunks, range);
        if (next) {
            range = next;
            continue;
        }
        const [subject, date] = git(['log', '-1', '--format=%s%x09%cI', sha]).trim().split('\t');
        // Changed by a commit that says it fixed something: the point was right. Changed otherwise: no verdict.
        return FIX.test(subject) ? { kind: 'outcome', pr: pr.number, comment: `outcome-${sha.slice(0, 12)}`, author: '', detail: `fixed later by ${sha.slice(0, 9)} "${subject}"`, at: date } : undefined;
    }
    const now = options.until ? Date.parse(options.until) : Date.now();
    const days = Math.floor((now - Date.parse(pr.mergedAt)) / DAY_MS);
    if (days < (options.windowDays ?? 30)) return undefined;
    return { kind: 'counter', pr: pr.number, comment: `counter-${pr.number}-${lesson.at.start}`, author: '', detail: `the lines shipped unchanged for ${days} days after the merge`, at: options.until ?? new Date().toISOString() };
}

/** A revert of the pull request on main, before `until`: an outcome for every point it left unaddressed. */
export function revertOf(git: Git, pr: MergedAt, options: OutcomeOptions): LessonEvidence | undefined {
    let log = '';
    try {
        log = git(['log', '--first-parent', '--format=%H%x09%cI%x09%s', ...(options.until ? [`--before=${options.until}`] : []), `${pr.mergeSha}..${options.mainRef}`]);
    } catch {
        return undefined;
    }
    for (const line of log.split('\n')) {
        const [sha, date, subject] = line.split('\t');
        if (sha && revertsPr(subject ?? '', pr)) {
            return { kind: 'outcome', pr: pr.number, comment: `revert-${sha.slice(0, 12)}`, author: '', detail: `the pull request was reverted by ${sha.slice(0, 9)} "${subject}"`, at: date };
        }
    }
    return undefined;
}

/** A commit subject that reverts the pull request: "Revert ..." naming its number or its merge commit. */
export function revertsPr(subject: string, pr: Pick<MergedAt, 'number' | 'mergeSha'>): boolean {
    return /^revert\b/i.test(subject) && (subject.includes(`#${pr.number}`) || subject.includes(pr.mergeSha.slice(0, 7)));
}

/** The range after a commit's hunks, or undefined when a hunk touched it. */
function shift(hunks: Hunk[], [start, end]: [number, number]): [number, number] | undefined {
    let offset = 0;
    for (const [s, e, removed, added] of hunks) {
        if (removed === 0) {
            // An insertion after line s: inside the range touches it, before it moves it down.
            if (s >= start && s < end) return undefined;
            if (s < start) offset += added;
            continue;
        }
        if (s <= end && start <= e) return undefined;
        if (e < start) offset += added - removed;
    }
    return [start + offset, end + offset];
}
