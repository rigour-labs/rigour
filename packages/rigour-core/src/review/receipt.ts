/**
 * The quality receipt for a change: for every changed function outside tests, what is known about
 * it before a model looks at anything.
 *
 * - reviewed: risky, and reviewed at its current code during development (the ledger or a
 *   committed reviewed.json, keyed by the function's exact source);
 * - changed since review: risky, reviewed once, then edited, so that review no longer counts;
 * - low risk: below the router's bar, left to the deterministic checks;
 * - not covered: risky with no review of this code. These are what a PR review should spend on.
 *
 * Reviews are agents' and people's own records. An independent (enforcing) review does not count
 * them, and the receipt says how many it set aside rather than hiding them.
 */
import { DEFAULT_MIN_SCORE, type RouterPolicy } from '../deep/router.js';
import { rankChangedFunctions, type FunctionRisk } from '../deep/risk.js';
import { activeLessons, DEFAULT_LESSON_MODE, type LessonMode } from '../review-learning/team-lessons.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { isReviewed, readLedger, reviewedKeys, type ReviewedKey } from './ledger.js';

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/i;

export interface ReceiptGap {
    file: string;
    function: string;
    start: number;
    score: number;
    /** Reviewed once, then edited. */
    changedSinceReview: boolean;
    /** The team lesson that made it risky, when one did. */
    lesson?: string;
}

export interface QualityReceipt {
    functions: number;
    reviewed: number;
    changedSinceReview: number;
    lowRisk: number;
    notCovered: ReceiptGap[];
    /** Who reviewed the functions counted as reviewed: agent, human, or byok:<model>. */
    reviewers: Record<string, number>;
    /** Changed files Rigour cannot split into functions (other languages, config): rules only. */
    otherFiles: number;
    /** Self-reported reviews an independent review did not count. */
    setAside: number;
}

export interface ReceiptOptions {
    policy?: RouterPolicy;
    lessonMode?: LessonMode;
    /** Trust nothing the change itself recorded (enforce mode). */
    independent?: boolean;
}

export function buildQualityReceipt(cwd: string, diff: string, options: ReceiptOptions = {}): QualityReceipt {
    const changed = changedLinesByFile(parseDiff(diff));
    const ranked = rankChangedFunctions(cwd, changed, removedByFile(diff), activeLessons(cwd, options.lessonMode ?? DEFAULT_LESSON_MODE));
    const minScore = options.policy?.min_score ?? DEFAULT_MIN_SCORE;
    const risky = ranked.filter(f => f.score >= minScore);
    const recorded = reviewedKeys(cwd);
    const trusted = options.independent ? [] : recorded;
    const reviewedNow = risky.filter(f => isReviewed(trusted, keyOf(f)));
    const gaps = risky.filter(f => !isReviewed(trusted, keyOf(f)));
    return {
        functions: ranked.length,
        reviewed: reviewedNow.length,
        changedSinceReview: gaps.filter(f => reviewedBefore(recorded, f)).length,
        lowRisk: ranked.length - risky.length,
        notCovered: gaps.map(f => ({
            file: f.file, function: f.name, start: f.start, score: f.score,
            changedSinceReview: reviewedBefore(recorded, f),
            ...(f.signals.lesson ? { lesson: f.signals.lesson } : {}),
        })),
        reviewers: reviewersOf(cwd, reviewedNow),
        otherFiles: Object.keys(changed).filter(file => !PARSEABLE.test(file)).length,
        setAside: options.independent ? risky.filter(f => isReviewed(recorded, keyOf(f))).length : 0,
    };
}

function keyOf(f: FunctionRisk): ReviewedKey {
    return { file: f.file, function: f.name, hash: f.hash };
}

/** Some version of this function was reviewed, just not the code it has now. */
function reviewedBefore(recorded: ReviewedKey[], f: FunctionRisk): boolean {
    return recorded.some(r => r.file === f.file && r.function === f.name && r.hash !== f.hash);
}

function reviewersOf(cwd: string, reviewed: FunctionRisk[]): Record<string, number> {
    const ledger = readLedger(cwd);
    const counts: Record<string, number> = {};
    for (const f of reviewed) {
        const entry = [...ledger].reverse().find(e => e.file === f.file && e.function === f.name && e.hash === f.hash);
        const who = entry ? (entry.reviewer.startsWith('byok:') ? 'model' : entry.reviewer) : 'recorded';
        counts[who] = (counts[who] ?? 0) + 1;
    }
    return counts;
}

/** The receipt as reports carry it (snake_case, like the rest of `rigour review --json` and the MCP tool). */
export function receiptReport(r: QualityReceipt) {
    return {
        functions: r.functions,
        reviewed: r.reviewed,
        changed_since_review: r.changedSinceReview,
        low_risk: r.lowRisk,
        not_covered: r.notCovered.map(g => ({ file: g.file, function: g.function, line: g.start, score: g.score, changed_since_review: g.changedSinceReview, ...(g.lesson ? { lesson: g.lesson } : {}) })),
        reviewers: r.reviewers,
        other_files: r.otherFiles,
        set_aside: r.setAside,
    };
}
