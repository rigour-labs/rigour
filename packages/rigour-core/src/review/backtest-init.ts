/**
 * `rigour backtest init --pr <n>`: a ledger scaffolded from a pull request's human reviews, one
 * round per review. An inline comment gives a point its file and a line window for free; a point
 * made in the review's body has neither, so it is written with `needs` set and a person adds the
 * text pattern once. The base of each round is the main branch as it was when the review was
 * posted, so a later merge does not change what the round measures.
 */
import fs from 'fs';
import path from 'path';
import { branchBase } from '../gates/logic-drift-git-base.js';
import { bodyPoints, firstLine } from '../review-learning/review-points.js';
import type { Config } from '../types/index.js';
import { LEDGER_PATH, LedgerSchema, type Ledger, type LedgerPoint, type LedgerRound } from './backtest.js';
import { defaultExec, githubEnv, parseJsonArrays, type Exec } from './reviewer.js';

const GH_TIMEOUT_MS = 60_000;

export interface PrRounds {
    /** One round per review by a person, oldest first. */
    rounds: LedgerRound[];
    /** When asked: the head a person approved, with no points, so a block on it is a false block. */
    approved?: LedgerRound;
}

/** The ledger rounds a pull request's human reviews give, and the commit a person approved. */
export async function roundsForPr(cwd: string, pr: number, config: Config, exec: Exec = defaultExec, options: { approvedHead?: boolean } = {}): Promise<PrRounds> {
    const env = await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec);
    const gh = (args: string[]) => exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS, env });
    const view = await gh(['pr', 'view', String(pr), '--json', 'author', '-q', '.author.login']);
    if (view.exitCode !== 0) throw new Error(`could not read pull request ${pr}: ${view.stderr.trim() || 'is gh signed in?'}`);
    const author = view.stdout.trim();
    const reviews = await gh(['api', `repos/{owner}/{repo}/pulls/${pr}/reviews`, '--paginate']);
    if (reviews.exitCode !== 0) throw new Error(`could not read the reviews of pull request ${pr}: ${reviews.stderr.trim()}`);
    const byPerson = parseJsonArrays(reviews.stdout).filter((r: any) => r?.user && r.user.type !== 'Bot' && !/bot/i.test(r.user.login) && r.user.login !== author);
    const humans = byPerson.filter((r: any) => r.body?.trim() || r.state === 'CHANGES_REQUESTED');
    const mainRef = branchBase(cwd)?.mainRef ?? 'origin/main';
    const rounds: LedgerRound[] = [];
    for (const [index, review] of humans.entries()) {
        const comments = await gh(['api', `repos/{owner}/{repo}/pulls/${pr}/reviews/${review.id}/comments`, '--paginate']);
        const inline = comments.exitCode === 0 ? parseJsonArrays(comments.stdout) : [];
        const round = index + 1;
        const points: LedgerPoint[] = inline.map((c: any, i: number) => inlinePoint(`R${round}-${i + 1}`, c));
        for (const [i, line] of bodyPoints(String(review.body ?? '')).entries()) {
            points.push({ id: `R${round}-B${i + 1}`, point: line, file: '', needs: 'a file pattern and a text pattern (this point was made in the review body, not on a line)' });
        }
        const base = await baseAt(cwd, String(review.commit_id), review.submitted_at, mainRef, exec);
        rounds.push({ id: `pr${pr}-r${round}`, commit: String(review.commit_id), base, reviewed_at: String(review.submitted_at), pr, points, must_not_flag: [] });
    }
    const approval = options.approvedHead ? byPerson.find((r: any) => r.state === 'APPROVED' && r.commit_id) : undefined;
    const approved = approval
        ? { id: `pr${pr}-approved`, commit: String(approval.commit_id), base: await baseAt(cwd, String(approval.commit_id), approval.submitted_at, mainRef, exec), reviewed_at: String(approval.submitted_at), approved: true, pr, points: [], must_not_flag: [] }
        : undefined;
    if (rounds.length === 0 && !approved) throw new Error(`pull request ${pr} has no review by a person yet`);
    return { rounds, ...(approved ? { approved } : {}) };
}

/** How many merged pull requests to list per one wanted, first: gh applies its limit before any sort of ours. */
const MERGED_OVERFETCH = 4;
/** The most merged pull requests listed per one wanted before Rigour stops and says the list may be incomplete. */
const MERGED_OVERFETCH_MAX = 32;

/** The last `n` merged pull requests, newest merge first; `incomplete` when the listing could not prove it has them all. */
export async function mergedPrs(cwd: string, n: number, config: Config, exec: Exec = defaultExec): Promise<{ prs: Array<{ number: number; mergedAt: string }>; incomplete: boolean }> {
    const env = await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec);
    // Listed by last update and sorted by merge date here. A merged pull request is updated at or after its merge, so once the
    // oldest update listed is no later than the Nth merge kept, nothing unlisted can be among the last N (its merge is no later
    // than its update, which is no later than that). Until then the listing doubles: bots that touch old pull requests after
    // merge (backports, labels, stale comments) can crowd a window.
    for (let limit = n * MERGED_OVERFETCH; ; limit *= 2) {
        const list = await exec('gh', ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--search', 'sort:updated-desc', '--json', 'number,mergedAt,updatedAt'], { cwd, timeoutMs: GH_TIMEOUT_MS, env });
        if (list.exitCode !== 0) throw new Error(`could not list merged pull requests: ${list.stderr.trim() || 'is gh signed in?'}`);
        let listed: Array<{ number: number; mergedAt: string; updatedAt: string }>;
        try {
            listed = JSON.parse(list.stdout);
        } catch {
            throw new Error('could not read the list of merged pull requests');
        }
        const prs = [...listed].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1)).slice(0, n).map(({ number, mergedAt }) => ({ number, mergedAt }));
        const oldestUpdate = listed.reduce((min, p) => (p.updatedAt < min ? p.updatedAt : min), listed[0]?.updatedAt ?? '');
        const complete = listed.length < limit || (prs.length === n && oldestUpdate <= prs[n - 1].mergedAt);
        if (complete) return { prs, incomplete: false };
        if (limit >= n * MERGED_OVERFETCH_MAX) return { prs, incomplete: true };
    }
}
/** Lines either side of an inline comment that a finding for the same point may land on. */
const LINE_SLACK = 10;

export async function scaffoldLedger(cwd: string, pr: number, config: Config, exec: Exec = defaultExec): Promise<{ file: string; rounds: LedgerRound[]; incomplete: number }> {
    const { rounds } = await roundsForPr(cwd, pr, config, exec);
    const file = path.join(cwd, LEDGER_PATH);
    const existing = existingLedger(file);
    const merged: Ledger = { rounds: [...existing.rounds.filter(r => !rounds.some(n => n.id === r.id)), ...rounds] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    return { file, rounds, incomplete: rounds.flatMap(r => r.points).filter(p => p.needs).length };
}

function inlinePoint(id: string, comment: any): LedgerPoint {
    const line = Number(comment.line ?? comment.original_line ?? 0);
    const body = String(comment.body ?? '').trim();
    return {
        id,
        point: firstLine(body),
        file: escape(String(comment.path ?? '')),
        ...(line > 0 ? { lines: [Math.max(1, line - LINE_SLACK), line + LINE_SLACK] as [number, number] } : { needs: 'a line window or a text pattern (the comment has no line)' }),
    };
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function existingLedger(file: string): Ledger {
    if (!fs.existsSync(file)) return { rounds: [] };
    const parsed = LedgerSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`${LEDGER_PATH} exists but is not a ledger; fix or remove it first`);
    return parsed.data;
}

/**
 * What the reviewer saw the change against: the merge-base of the reviewed commit and main as of the review.
 * Not main itself: a branch that merged main in already has main's newer commits, and diffing from an older
 * main would review them as the branch's own. Main as of the review when the commit is not fetched here.
 */
async function baseAt(cwd: string, commit: string, reviewedAt: string, mainRef: string, exec: Exec): Promise<string> {
    const main = (await exec('git', ['rev-list', '-1', `--before=${reviewedAt}`, mainRef], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim() || mainRef;
    const mergeBase = await exec('git', ['merge-base', commit, main], { cwd, timeoutMs: GH_TIMEOUT_MS });
    return (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) || main;
}
