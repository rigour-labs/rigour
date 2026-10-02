/**
 * Studio's "Progress": how Rigour is shaping this codebase over time. Week by week: problems
 * stopped before a PR, repeat mistakes stopped (and, when recorded, that reached a PR), how often
 * people overruled Rigour, how fast agents fixed what it reported, and how much it has learned.
 * Rankings are of lessons and checks, never of people.
 */
import { isMuted, precisionOf, readOutcomes, type CheckOutcome, type CheckPrecision, type Story } from '@rigour-labs/core';
import { checkoutRoots, storiesAcross } from './studio-checkouts.js';
import { loadLearning, type LessonJourney, type StudioLearning } from './studio-learning.js';
import { readDismissals, type Dismissal } from './studio-week.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const PROGRESS_WEEKS = 8;
const TOP = 5;

export interface ProgressWeek {
    from: string;
    stopped: number;
    overruled: number;
    repeatsStopped: number;
    repeatsReachedPr: number | null;
    /** Median minutes from report to fix; null when no fix that week recorded both times. */
    minutesToFix: number | null;
    /** Lessons that existed by the end of the week. */
    lessons: number;
}

export interface StudioProgress {
    weeks: ProgressWeek[];
    topLessons: Array<Pick<LessonJourney, 'id' | 'text' | 'stoppedInDevelopment' | 'scope'>>;
    checks: Array<Pick<CheckPrecision, 'check' | 'fixed' | 'dismissed' | 'precision' | 'muted'>>;
}

export function buildProgress(input: { now: Date; stories: Story[]; dismissals: Dismissal[]; learning: StudioLearning; checks: CheckPrecision[] }): StudioProgress {
    const weeks = input.learning.weeks.map(w => {
        const start = Date.parse(w.from);
        const end = start + WEEK_MS;
        const within = (at: string) => Date.parse(at) > start && Date.parse(at) <= end;
        const fixed = input.stories.filter(s => s.stage !== 'pr' && within(s.at));
        const minutes = fixed.flatMap(s => (s.openedAt ? [(Date.parse(s.at) - Date.parse(s.openedAt)) / 60_000] : [])).filter(m => m >= 0);
        return {
            from: w.from,
            stopped: fixed.length,
            overruled: input.dismissals.filter(d => within(d.at)).length,
            repeatsStopped: w.stoppedInDevelopment,
            repeatsReachedPr: w.reachedPr,
            minutesToFix: median(minutes),
            lessons: input.learning.lessons.filter(l => Date.parse(l.learnedAt) <= end).length,
        };
    });
    return {
        weeks,
        topLessons: input.learning.lessons
            .filter(l => (l.stoppedInDevelopment ?? 0) > 0)
            .sort((a, b) => (b.stoppedInDevelopment ?? 0) - (a.stoppedInDevelopment ?? 0))
            .slice(0, TOP)
            .map(({ id, text, stoppedInDevelopment, scope }) => ({ id, text, stoppedInDevelopment, scope })),
        checks: [...input.checks]
            .sort((a, b) => b.precision - a.precision || (b.fixed + b.dismissed) - (a.fixed + a.dismissed))
            .map(({ check, fixed, dismissed, precision, muted }) => ({ check, fixed, dismissed, precision, muted })),
    };
}

export async function loadProgress(cwd: string, now = new Date()): Promise<StudioProgress> {
    const roots = checkoutRoots(cwd);
    const learning = await loadLearning(cwd, now, PROGRESS_WEEKS);
    return buildProgress({ now, stories: storiesAcross(roots), dismissals: readDismissals(cwd), learning, checks: precisionsAcross(roots) });
}

/** Each check's fixed and dismissed counts summed over every checkout, then scored as in check-outcomes. */
export function precisionsAcross(roots: string[]): CheckPrecision[] {
    const totals: Record<string, CheckOutcome> = {};
    for (const root of roots) {
        for (const [check, outcome] of Object.entries(readOutcomes(root))) {
            const t = totals[check] ?? { fixed: 0, dismissed: 0 };
            totals[check] = { fixed: t.fixed + outcome.fixed, dismissed: t.dismissed + outcome.dismissed };
        }
    }
    return Object.entries(totals).map(([check, o]) => ({ check, ...o, precision: precisionOf(o), muted: isMuted(o) }));
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
