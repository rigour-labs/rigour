/**
 * The reviewer: a fresh, read-only review of a branch by the person's own coding-agent CLI, from
 * what a human reviewer works from (every human review on the pull request, the description, the
 * diff, the repository's rules), with four outcomes and nothing advisory:
 *   passed       no open item;
 *   findings     open items, each with file:line and a stable id;
 *   unavailable  no valid verdict (the CLI missing, an API error, a timeout, a malformed answer,
 *                the pull request unreachable): never a pass;
 *   skipped      no model was asked, because nobody will read this push yet (no pull request, a
 *                draft, a closed one) and `review.reviewer.when` is `ready_pr`; the commit still
 *                owes a review, and `rigour review --reviewer`, a backtest or `full` always review.
 *
 * The verdict is cached per commit under a fingerprint of every input (base, prompt, reviewers
 * and their versions, rules, description, every human review), so an unchanged commit is not
 * re-reviewed. After a full verdict on a branch, the next pushes get a delta review: the reviewer
 * sees the previous open items and only the commits since, and must carry or resolve (with
 * evidence) every one; an item it leaves out stays open. A full review runs again when the base
 * is merged in (with how main changed the files the branch imports), when a human review appears,
 * when the rules or reviewers change, after four deltas, or for a delta over 400 lines.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Config } from '../types/index.js';
import { ADAPTERS, isReviewerName, resolveAdapter, selectReviewers, vendorsOf, type Installed, type ReviewMode, type ReviewerName } from './reviewer/adapters.js';
import { defaultExec, GH_TIMEOUT_MS, githubEnv, type Exec, type Progress } from './reviewer/exec.js';
import { findPullRequest, ghFor, humanReviews, linesChanged, mergesBaseIn, rulesText, sha, type HumanReviews, type PullRequest } from './reviewer/inputs.js';
import { mergeImpact } from './reviewer/merge-impact.js';
import { deltaBlock, mergeBlock, PROMPT_VERSION, renderPrompt } from './reviewer/prompt.js';
import { VerdictStore } from './reviewer/store.js';
import { account, carryResolved, evidenceTouched, mergeVerdicts, parseVerdict, type Accounting, type OpenItem, type PriorPoint, type Verdict } from './reviewer/verdict.js';

export { defaultExec, githubEnv, parseJsonArrays, type Exec, type Progress } from './reviewer/exec.js';
export { itemLine, type OpenItem, type Verdict } from './reviewer/verdict.js';

export type ReviewerOutcome = 'passed' | 'findings' | 'unavailable' | 'skipped';

export interface ReviewerOptions {
    /** The pull request to read when the checkout is detached (a backtest). */
    pr?: number;
    /** ISO time: a review or comment posted from then on is not shown to the reviewer (a backtest). */
    reviewsBefore?: string;
    /** At push the ready-pull-request rule applies; a review command or a backtest always reviews. */
    trigger?: 'push' | 'review' | 'backtest';
    /** Two vendors, verdicts merged: the step before requesting a human review. */
    full?: boolean;
    /** Review again even when a verdict for these inputs is cached. */
    force?: boolean;
    /** Deterministic hints (a nested scan, a property that only leaves through serialisation): candidates for the reviewer to confirm. */
    hints?: string;
    /** The branch the commit was pushed from, when reviewing it in a detached worktree (background.ts). */
    branch?: string;
}

export interface ReviewerResult {
    outcome: ReviewerOutcome;
    /** What blocks: every open item, with a stable id. */
    items: OpenItem[];
    /** Items naming code the checkout does not have: shown, never a block. */
    unverified: OpenItem[];
    /** Previous open items resolved since the last verdict, with the evidence. */
    resolved: Accounting['resolved'];
    /** Non-blocking human points still open: answered in the reply, not held against the push. */
    answerInReply: PriorPoint[];
    /** Why there is no verdict (unavailable) or why none was sought (skipped). */
    reason?: string;
    reviewers: ReviewerName[];
    scope?: 'full' | 'delta';
    why?: string;
    costUsd?: number;
    cached: boolean;
    /** The latest human review it worked from (`<login>, <date> (<n> reviews)`). */
    previousReview?: string;
    pr?: number;
}

/** Findings and no verdict stop a push; a skipped review does not, and is reported as owed. */
export function reviewerBlocks(result: ReviewerResult): boolean {
    return result.outcome === 'findings' || result.outcome === 'unavailable';
}

const PROGRESS_EVERY_MS = 60_000;
const MAX_DELTAS = 4;
const MAX_DELTA_LINES = 400;

export async function runReviewer(cwd: string, base: string, config: Config, exec: Exec = defaultExec, progress: Progress = message => process.stderr.write(`${message}\n`), options: ReviewerOptions = {}): Promise<ReviewerResult> {
    const settings = config.review?.reviewer ?? { enabled: false, on_push: 'background' as const, reviewers: ['claude'], mode: 'single' as const, models: {}, timeout_ms: 15 * 60_000 };
    const trigger = options.trigger ?? (options.reviewsBefore ? 'backtest' : 'review');
    const git = async (args: string[]) => (await exec('git', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
    const head = await git(['rev-parse', 'HEAD']);
    const baseSha = await git(['rev-parse', `${base}^{commit}`]);
    const branch = options.branch ?? await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const repoRoot = (await git(['rev-parse', '--show-toplevel'])) || cwd;
    const none = (outcome: 'unavailable' | 'skipped', reason: string, extra: Partial<ReviewerResult> = {}): ReviewerResult =>
        ({ outcome, items: [], unverified: [], resolved: [], answerInReply: [], reason, reviewers: [], cached: false, ...extra });
    if (!head || !baseSha) return none('unavailable', `not a repository, or ${base} is unknown`);
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return none('unavailable', 'no git directory to keep verdicts in');

    const candidates = settings.reviewers.filter(isReviewerName);
    const installed = new Map<ReviewerName, Installed>();
    for (const name of candidates) {
        const found = await resolveAdapter(ADAPTERS[name], cwd, exec);
        if (found) installed.set(name, found);
    }
    const authors = vendorsOf(await git(['log', '--format=%(trailers:key=Co-Authored-By,valueonly)%(trailers:key=Co-authored-by,valueonly)', `${baseSha}..HEAD`]));
    const mode: ReviewMode = options.full ? 'full' : settings.mode;
    const reviewers = selectReviewers(candidates, mode, authors, new Set(installed.keys()));
    if (reviewers.length === 0) return none('unavailable', `no reviewer installed: ${candidates.map(n => ADAPTERS[n].binary).join(', ') || 'review.reviewer.reviewers is empty'}`);
    const reviewerVersions = reviewers.map(name => `${name} ${installed.get(name)!.version}`).join(';');

    const gh = ghFor(cwd, exec, await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec));
    const found = await findPullRequest(gh, branch, head, options.pr);
    if (found.error) return none('unavailable', found.error, { reviewers });
    const pr = found.pr;
    if (trigger === 'push' && !options.full && !options.force) {
        const skip = skipReason(settings.on_push, branch, pr);
        if (skip) return none('skipped', skip, { reviewers, pr: pr?.number });
    }
    let reviews: HumanReviews = { markdown: 'none\n', key: '', count: 0 };
    if (pr) {
        const read = await humanReviews(gh, pr, options.reviewsBefore);
        if (read.error) return none('unavailable', read.error, { reviewers, pr: pr.number });
        reviews = read.reviews!;
    }
    const body = pr?.body || '(no pull request description)\n';
    const rules = rulesText(cwd);
    const rulesHash = sha([reviewerVersions, PROMPT_VERSION, rules, body, reviews.key]);

    // Full or delta.
    const previous = branch !== 'HEAD' ? store.branchState(branch) : undefined;
    const mergedBase = await mergesBaseIn(cwd, baseSha, exec);
    let scope: 'full' | 'delta' = 'full';
    let why: string;
    if (options.full) why = 'full review requested';
    else if (!previous || !fs.existsSync(previous.verdict)) why = `no earlier verdict on ${branch}`;
    else if ((await exec('git', ['merge-base', '--is-ancestor', previous.head, 'HEAD'], { cwd, timeoutMs: GH_TIMEOUT_MS })).exitCode !== 0) why = `last reviewed commit ${previous.head.slice(0, 9)} is not an ancestor (rebase or amend)`;
    else if (mergedBase) why = `HEAD merges ${base}`;
    else if (previous.reviewsKey !== reviews.key) why = 'a human review changed';
    else if (previous.rulesHash !== rulesHash) why = 'prompt, rules or reviewers changed';
    else if (previous.chain >= MAX_DELTAS) why = `${previous.chain} delta reviews since the last full one`;
    else if ((await linesChanged(cwd, previous.head, 'HEAD', exec)) > MAX_DELTA_LINES) why = `delta over ${MAX_DELTA_LINES} lines`;
    else if (previous.head === head) why = 'same commit as the last verdict';
    else {
        scope = 'delta';
        why = `since ${previous.head.slice(0, 9)}`;
    }
    const previousVerdictText = scope === 'delta' ? fs.readFileSync(previous!.verdict, 'utf8') : '';
    const fingerprint = sha([head, baseSha, scope, reviewerVersions, PROMPT_VERSION, rules, body, reviews.key, previousVerdictText]);
    const verdictFile = store.verdictPath(head, fingerprint);
    const openFile = store.openPath(verdictFile);
    const previousOpen = scope === 'delta' ? store.readJson<OpenItem[]>(store.openPath(previous!.verdict)) ?? [] : undefined;

    const verify = verifier(cwd);
    if (!options.force && fs.existsSync(verdictFile) && fs.existsSync(openFile)) {
        const verdict = store.readJson<Verdict>(verdictFile)!;
        const accounted = account(verdict, previousOpen, verify);
        return result(accounted, verdict, reviewers, scope, why, true, reviews, pr);
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-reviewer-'));
    try {
        const file = (name: string, text: string) => {
            const target = path.join(work, name);
            fs.writeFileSync(target, text);
            return target;
        };
        const reviewsFile = file('previous-reviews.md', reviews.markdown);
        const prBodyFile = file('pr-description.md', body);
        const diffstatFile = file('diffstat.txt', await git(['diff', '--stat', `${baseSha}...HEAD`]));
        const diffFile = file('full.diff', (await exec('git', ['diff', `${baseSha}...HEAD`], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout);
        const hintsFile = file('hints.txt', options.hints?.trim() || 'none\n');
        let delta = '';
        // A reviewer must report on the human reviews, unless every point was settled by the previous verdict and is carried.
        let needsPriorPoints = reviews.count > 0;
        if (scope === 'delta') {
            const previousOpenFile = file('previous-open.json', JSON.stringify(previousOpen, null, 2));
            const commitsFile = file('delta-commits.txt', await git(['log', '--format=%h %s', `${previous!.head}..HEAD`]));
            const deltaDiffFile = file('delta.diff', (await exec('git', ['diff', `${previous!.head}..HEAD`], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout);
            // Human points the previous verdict resolved, whose files the new commits leave alone, are not judged again.
            const touchedFiles = new Set((await git(['diff', '--name-only', `${previous!.head}..HEAD`])).split('\n').filter(Boolean));
            const settled = (store.readJson<Verdict>(previous!.verdict)?.prior_points ?? []).filter(p => p.resolved && !evidenceTouched(p.evidence, touchedFiles));
            const settledFile = file('previous-resolved.json', JSON.stringify(settled, null, 2));
            delta = deltaBlock(previous!.head, previous!.verdict, previousOpenFile, commitsFile, deltaDiffFile, settledFile);
            if (settled.length) needsPriorPoints = false;
        }
        let merge = '';
        if (mergedBase) {
            const impact = await mergeImpact(cwd, await git(['merge-base', 'HEAD^1', 'HEAD^2']), 'HEAD^2', 'HEAD', exec);
            merge = mergeBlock(base, impact ? file('merge-impact.md', impact) : undefined);
        }
        const prompt = renderPrompt({ repoRoot, branch, head: head.slice(0, 9), base, baseSha, mode: scope, reviewsFile, humanCount: reviews.count, prBodyFile, diffstatFile, diffFile, hintsFile, deltaBlock: delta, mergeBlock: merge });
        progress(`Rigour reviewer: reviewing ${head.slice(0, 9)} against ${base} (${scope}: ${why}; ${reviews.count} human review(s), written by ${[...authors].join(', ') || 'a person'}) with ${reviewers.join(', ')}`);
        const started = Date.now();
        const ticker = setInterval(() => progress(`Rigour reviewer: still working (${Math.round((Date.now() - started) / 60_000)} min)`), PROGRESS_EVERY_MS);
        let parts: Verdict[];
        try {
            const answers = await Promise.all(reviewers.map(async name => {
                const adapter = ADAPTERS[name];
                const model = settings.models[name] ?? (name === 'claude' ? settings.model : undefined);
                const run = await exec(installed.get(name)!.binary, adapter.args(prompt, model), { cwd, timeoutMs: settings.timeout_ms });
                progress(`Rigour reviewer: ${name} finished in ${Math.round((Date.now() - started) / 1000)}s (exit ${run.exitCode})`);
                const answer = adapter.answer(run.stdout);
                return run.exitCode === 0 || answer.text.trim()
                    ? parseVerdict(answer.text, needsPriorPoints, name, answer.costUsd)
                    : { error: `${name}: no answer (exit ${run.exitCode}): ${run.stderr.trim().slice(-200)}` };
            }));
            const failed = answers.find(a => 'error' in a);
            if (failed && 'error' in failed) return none('unavailable', failed.error, { reviewers, scope, why, pr: pr?.number });
            parts = answers.map(a => (a as { verdict: Verdict }).verdict);
        } finally {
            clearInterval(ticker);
        }
        const merged = mergeVerdicts(parts); // one part too: every item is tagged with who found it
        const touched = scope === 'delta' ? new Set((await git(['diff', '--name-only', `${previous!.head}..HEAD`])).split('\n').filter(Boolean)) : new Set<string>();
        const verdict = scope === 'delta' ? carryResolved(merged, store.readJson<Verdict>(previous!.verdict), touched) : merged;
        const accounted = account(verdict, previousOpen, verify);
        store.writeJson(verdictFile, { ...verdict, inputs: { head, base: baseSha, scope, why, reviewers, versions: reviewerVersions, authors: [...authors], fingerprint, human_reviews: reviews.count, reviews_before: options.reviewsBefore ?? null, since: previous?.head ?? null, at: new Date().toISOString() } });
        store.writeJson(openFile, accounted.open);
        if (branch !== 'HEAD') store.recordBranch(branch, { head, verdict: verdictFile, mode: scope, rulesHash, reviewsKey: reviews.key });
        return result(accounted, verdict, reviewers, scope, why, false, reviews, pr);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** Why no model is asked at this push: `review.reviewer.on_push` and whether someone will read the push (an open, non-draft pull request). */
function skipReason(onPush: 'background' | 'wait' | 'off', branch: string, pr: PullRequest | undefined): string | undefined {
    if (onPush === 'off') return 'review.reviewer.on_push is off: run `rigour review --reviewer`';
    if (!pr) return `no pull request for ${branch} yet; the review runs once one is open and ready, or now with \`rigour review --reviewer\``;
    if (pr.draft) return `pull request #${pr.number} is a draft; the review runs once it is ready, or now with \`rigour review --reviewer\``;
    if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
    return undefined;
}

/** A file in the checkout, and a line it has: an item naming anything else is a reviewer's slip. */
function verifier(cwd: string): (file: string, line: number | undefined) => boolean {
    const lengths = new Map<string, number>();
    return (file, line) => {
        const target = path.join(cwd, file);
        if (!lengths.has(file)) {
            try {
                lengths.set(file, fs.readFileSync(target, 'utf8').split('\n').length);
            } catch {
                lengths.set(file, -1);
            }
        }
        const length = lengths.get(file)!;
        return length >= 0 && (line === undefined || line <= length);
    };
}

function result(accounted: Accounting, verdict: Verdict, reviewers: ReviewerName[], scope: 'full' | 'delta', why: string, cached: boolean, reviews: HumanReviews, pr: PullRequest | undefined): ReviewerResult {
    const cost = (verdict.reviewers ?? []).map(r => r.cost_usd).filter((c): c is number => typeof c === 'number');
    return {
        outcome: accounted.open.length ? 'findings' : 'passed',
        items: accounted.open,
        unverified: accounted.unverified,
        resolved: accounted.resolved,
        answerInReply: accounted.answerInReply,
        reviewers,
        scope,
        why,
        ...(cost.length ? { costUsd: cost.reduce((a, b) => a + b, 0) } : {}),
        cached,
        ...(reviews.label ? { previousReview: reviews.label } : {}),
        ...(pr ? { pr: pr.number } : {}),
    };
}
