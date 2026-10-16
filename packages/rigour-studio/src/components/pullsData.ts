/** What /api/pulls and /api/pull send (rigour-cli studio-pulls*.ts), and the words the Pull requests page uses for it. */

type PullState = 'not-opened' | 'open' | 'merged' | 'reverted';
type CiResult = 'success' | 'failure' | 'pending' | 'none' | 'unavailable';

export interface PullRow {
    key: string;
    pr: number | null;
    title: string | null;
    branches: string[];
    state: PullState;
    lastReview: { at: string; outcome: string; blocking: number; shouldFix: number } | null;
    rounds: number;
    lessonsApplied: number;
    blockingFound: number;
    ci: CiResult | null;
    followUps: { commits: number; fixes: number } | null;
    firstAt: string;
    lastActivity: string;
}

export interface PullsList {
    rows: PullRow[];
    window: { days: number; reviewed: number; blocking: number; lessonsApplied: number; merged: number; mergedClean: number };
    mergesRecorded: boolean;
    threadsRecorded: boolean;
}

interface Judge { reviewer: string; model: string | null; version: string | null }
interface ReportedCost { usd: number; by: string; basis: 'judge' | 'all runs' | 'review' }

export interface Round {
    at: string;
    head: string | null;
    trigger: string | null;
    outcome: string;
    blocking: number;
    shouldFix: number;
    judges: Judge[];
    recorded: boolean;
    rules: { served: number; followed: number; broken: number; notApplicable: number; brokenNames: string[] } | null;
    lessons: { served: number | null; applied: Array<{ id: string; text: string | null }> };
    disputed: number | null;
    humanReviews: number | null;
    blind: boolean;
    cost: ReportedCost[];
}

interface Merge {
    at: string;
    sha: string | null;
    ci: CiResult | null;
    followUps: Array<{ sha: string; at: string; subject: string; fix: boolean }> | null;
    followUpCount: number | null;
    fixes: number | null;
    reverted: { sha: string | null; subject: string | null } | null;
    settled: boolean;
    author: string | null;
    source: 'outcomes' | 'thread';
}

interface HumanPoint { lesson: string; text: string; author: string; source: 'person' | 'bot' | null; state: string; at: string | null }

export interface PullDetail {
    found: true;
    key: string;
    pr: number | null;
    title: string | null;
    branches: string[];
    state: PullState;
    firstAt: string;
    lastAt: string;
    steps: {
        brief: { at: string; count: number; items: number; agents: string[] } | null;
        edits: { at: string; checks: number; findings: number; files: number; flagged: number; cleaned: number; agents: string[] } | null;
        stop: { at: string; count: number; blocked: number; clean: number; agents: string[] } | null;
        push: { at: string; count: number; passed: number; failed: number } | null;
        reviews: Round[];
        human: { reviews: number | null; points: HumanPoint[] };
        merge: Merge | null;
    };
    facts: {
        caughtBeforeReview: { findings: number; stops: number; pushes: number } | null;
        repeats: Array<{ id: string; text: string | null }>;
        rounds: number;
        durationMs: number | null;
        judges: Array<Judge & { runs: number }>;
        cost: ReportedCost[];
    };
}

export type PullAnswer = PullDetail | { found: false; key: string };

export const STATE_WORDS: Record<PullState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'plain'; note: string }> = {
    'not-opened': { label: 'Not opened yet', tone: 'plain', note: 'Reviewed by Rigour before a pull request existed.' },
    open: { label: 'Open', tone: 'info', note: 'No merge recorded on this machine. Run rigour outcomes to read merges from GitHub.' },
    merged: { label: 'Merged', tone: 'ok', note: 'Merged, as recorded.' },
    reverted: { label: 'Reverted', tone: 'bad', note: 'A later commit on main reverted it.' },
};

const CI_WORDS: Record<CiResult, string> = {
    success: 'passed',
    failure: 'broke on merge',
    pending: 'still running',
    none: 'no CI runs',
    unavailable: 'GitHub did not say',
};

export function ciWords(ci: CiResult | null): string {
    return ci ? CI_WORDS[ci] : '—';
}

const OUTCOME_WORDS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'plain' }> = {
    passed: { label: 'passed', tone: 'ok' },
    findings: { label: 'found problems', tone: 'bad' },
    unavailable: { label: 'could not run', tone: 'warn' },
};

export function outcomeWords(outcome: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'plain' } {
    return OUTCOME_WORDS[outcome] ?? { label: outcome, tone: 'plain' };
}

/** "3 h 20 min", "2 days 4 h". */
export function duration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} days${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** Dollars only as recorded, with whose figure it is; a CLI judge's figure is what the same use would cost on the API. */
export function costWords(cost: ReportedCost): string {
    const whose = cost.basis === 'all runs' ? `as reported by ${cost.by}, every run of the review` : `as reported by ${cost.by}`;
    return `$${cost.usd.toFixed(2)} ${whose}`;
}

export const COST_NOTE = 'A judge that runs through a subscription CLI reports what the same use would cost on the API: not a bill.';

export function prLabel(row: { pr: number | null; branches: string[] }): string {
    return row.pr !== null ? `#${row.pr}` : row.branches[row.branches.length - 1] ?? '';
}
