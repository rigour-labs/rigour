/**
 * A review task for the developer's own coding agent (or the developer).
 *
 * Inside Claude Code, Cursor and the like, a frontier model is already
 * running and already paid for. Rigour does not need to call a model of its
 * own: it picks the changed functions worth a careful look (risk.ts), says
 * what to check in each, and records the agent's verdict in the ledger.
 * On real PRs, a model that read the repository with these questions in mind
 * pre-empted four times as many acted-on review comments as chunked prompts.
 */
import { DEFAULT_MAX_FUNCTIONS, DEFAULT_MIN_SCORE, type RouterPolicy } from '../deep/router.js';
import { rankChangedFunctions, type FunctionRisk } from '../deep/risk.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { isReviewed, reviewedKeys } from './ledger.js';
import { lessonsForDiff, type LessonMode } from '../review-learning/team-lessons.js';
import { rulesForDiff } from '../review-learning/repo-rules.js';

export interface ReviewTaskItem {
    file: string;
    function: string;
    start: number;
    end: number;
    score: number;
    hash: string;
    /** What to check, from the function's risk signals. */
    questions: string[];
}

export interface ReviewTask {
    items: ReviewTaskItem[];
    /** Risky functions already reviewed at their current content. */
    alreadyReviewed: number;
    /** The team's past review lessons that apply to this change. */
    lessons: Array<{ file: string; text: string; prs: number[] }>;
    /** The repository's own rules (AGENTS.md, …) that name what this change touches. */
    rules: Array<{ source: string; text: string }>;
    instructions: string;
}

const QUESTIONS: Record<string, string> = {
    'data-write': 'Is the write safe under concurrent calls (no check-then-act), idempotent on retry, and does an upsert/conflict clause do what the caller expects?',
    paging: 'Can the cursor, offset or limit skip, repeat or stall rows at page boundaries, caps or retries?',
    auth: 'Is every path authorized, and are tokens or secrets kept out of logs, errors and responses?',
    'money-or-time': 'Are units, rounding, time zones and clock comparisons consistent with the callers?',
    concurrency: 'What happens if two calls overlap, or one step fails half-way through?',
    network: 'Are timeouts, aborts and non-2xx responses handled, and does a retry repeat a side effect?',
};

export function buildReviewTask(cwd: string, diff: string, policy: RouterPolicy = {}, lessonMode: LessonMode = 'off', repoRules = false): ReviewTask {
    const changed = parseDiff(diff);
    const ranked = rankChangedFunctions(cwd, changedLinesByFile(changed), removedByFile(diff));
    const risky = ranked.filter(f => f.score >= (policy.min_score ?? DEFAULT_MIN_SCORE)).slice(0, policy.max_functions ?? DEFAULT_MAX_FUNCTIONS);
    const reviewed = reviewedKeys(cwd);
    const pending = risky.filter(f => !isReviewed(reviewed, { file: f.file, function: f.name, hash: f.hash }));
    const lessons = lessonsForDiff(cwd, diff, lessonMode).map(l => ({ file: l.file, text: l.text, prs: [...new Set(l.evidence.map(e => e.pr))] }));
    return {
        items: pending.map(toItem),
        alreadyReviewed: risky.length - pending.length,
        lessons,
        rules: rulesForDiff(cwd, diff, repoRules).map(r => ({ source: r.source, text: r.text })),
        instructions: pending.length === 0
            ? 'No risky changed function is waiting for review.'
            : 'For each item: read the function, its callers and what it calls; answer its questions against the code. '
            + 'Fix any real defect. Then call rigour_review_ack with verdict "fixed" or "no_issue" and a one-line note saying what you checked.',
    };
}

function toItem(f: FunctionRisk): ReviewTaskItem {
    const questions = [
        ...(f.signals.removedGuard ? ['The change removed a condition, return or throw here: which inputs did it guard against, and are they still handled?'] : []),
        ...f.signals.sensitive.map(kind => QUESTIONS[kind]).filter(Boolean),
        `Do the callers of \`${f.name}\` still get what they assume (types, empty and error cases)?`,
    ];
    return { file: f.file, function: f.name, start: f.start, end: f.end, score: f.score, hash: f.hash, questions };
}
