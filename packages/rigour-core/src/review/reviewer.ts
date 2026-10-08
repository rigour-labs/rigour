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
import { runApiJudge } from './reviewer/api-judge.js';
import { ADAPTERS, apiVendor, isReviewerName, resolveAdapter, selectReviewers, vendorsOf, type Installed, type ReviewMode, type ReviewerName, type RunTrace, type Tokens } from './reviewer/adapters.js';
import { defaultExec, GH_TIMEOUT_MS, githubEnv, type Exec, type Progress } from './reviewer/exec.js';
import { bodyAsOf, findPullRequest, ghFor, humanReviews, linesChanged, mergesBaseIn, rulesText, sha, type HumanReviews, type PullRequest } from './reviewer/inputs.js';
import { mergeImpact } from './reviewer/merge-impact.js';
import { applyPanel, parseAnswers, runPanel, type PanelItem } from './reviewer/panel.js';
import { crossExamPrompt, deltaBlock, mergeBlock, PROMPT_VERSION, renderPrompt } from './reviewer/prompt.js';
import { resolveReviewer, type ResolvedReviewer, type RunChoice, type Source } from './reviewer/settings.js';
import { VerdictStore } from './reviewer/store.js';
import { trackUsage } from '../telemetry/telemetry.js';
import { reviewerUsage } from './reviewer/usage.js';
import { buildContext, dismissedAs, readReviewDismissals, relatedDocs, type ReviewDismissal } from './reviewer/context.js';
import { buildRecord, type ReviewRecord } from './reviewer/record.js';
import { account, attachServedRules, checkoutVerifier, carryResolved, evidenceTouched, mergeVerdicts, parseVerdict, type Accounting, type OpenItem, type PriorPoint, type Verdict } from './reviewer/verdict.js';
import { judgeUnset } from './reviewer/judge-env.js';

export { defaultExec, githubEnv, githubToken, parseJsonArrays, type Exec, type Progress } from './reviewer/exec.js';
export { itemLine, type OpenItem } from './reviewer/verdict.js';

export type ReviewerOutcome = 'passed' | 'findings' | 'unavailable' | 'skipped';

export interface ReviewerOptions {
    /** For tests: what the API judge calls instead of fetch. */
    fetch?: typeof fetch;
    /** The pull request to read when the checkout is detached (a backtest). */
    pr?: number;
    /** ISO time: a review or comment posted from then on is not shown to the reviewer (a backtest). */
    reviewsBefore?: string;
    /** No pull request at all: the commit is reviewed alone, with no human review or description, and GitHub is never asked (a backtest round that names no pull request). */
    blind?: boolean;
    /** At push the ready-pull-request rule applies; a review command or a backtest always reviews. */
    trigger?: 'push' | 'review' | 'backtest';
    /** Two vendors over the whole branch, never a delta: the step before requesting a human review. */
    full?: boolean;
    /** This run's own choice of mode and panel, the nearest layer of the settings (reviewer/settings.ts). */
    choice?: RunChoice;
    /** Review again even when a verdict for these inputs is cached. */
    force?: boolean;
    /** Deterministic hints (a nested scan, a property that only leaves through serialisation): candidates for the reviewer to confirm. */
    hints?: string;
    /** What Rigour's checks already found on this change: settled, so no judge spends a turn finding it again. */
    checks?: string[];
    /** Where the team's state lives (.rigour: dismissals, reviewed functions) when cwd is a worktree that lacks it. */
    stateRoot?: string;
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
    /** Findings with no wrong outcome and no cost: shown, never a block. */
    notes: OpenItem[];
    /** Should-fixes with a verified quote: shown, capped, never a block. */
    advisory: OpenItem[];
    /** Panel findings without a majority: shown, never a block, not carried to the next round. */
    disputed: OpenItem[];
    /** Panel findings refuted with evidence: logged, never a block. */
    dropped: OpenItem[];
    /** Findings the team dismissed as not a bug (`rigour dismiss <id>`), raised again: shown, never a block. */
    dismissed: OpenItem[];
    /** The panel's decision on every finding, with each judge's call: what a later re-scoring fits on. */
    panel?: PanelItem[];
    /** Why there is no verdict (unavailable) or why none was sought (skipped). */
    reason?: string;
    reviewers: ReviewerName[];
    scope?: 'full' | 'delta';
    why?: string;
    costUsd?: number;
    /** The repository's own rules the judge answered, and how. */
    rules?: { checked: number; followed: number; broken: number; notApplicable: number };
    /** The record of this review (record.ts) and where it is kept, beside the verdict. */
    record?: ReviewRecord;
    recordPath?: string;
    /** Tokens every run reported, summed: the only measure of a CLI that reports no dollars (Codex). */
    tokens?: Tokens;
    /** Whether the team lets people dismiss these findings (review.reviewer.dismissals). */
    dismissable?: boolean;
    /** Agent runs behind this verdict: one per judge, plus each cross-examination. */
    runs?: number;
    /** The mode asked for, the one that ran, where the choice came from, and why it ran with fewer judges. */
    mode?: ModeRecord;
    cached: boolean;
    /** The latest human review it worked from (`<login>, <date> (<n> reviews)`). */
    previousReview?: string;
    pr?: number;
}

export interface ModeRecord {
    asked: 'single' | 'cross' | 'full' | 'panel';
    /** `none` when the review ended before any judge ran (unavailable or skipped); `degraded` or the reason says why. */
    ran: 'single' | 'cross' | 'full' | 'panel' | 'none';
    source: Source;
    /** Why fewer judges ran than were asked for. */
    degraded?: string;
    /** Nearer choices that were not applied, such as a user turning off a panel the team requires. */
    refused?: string[];
    /** With escalate: risk, why this review got one judge or all of them. */
    escalation?: string;
}

/** Findings and no verdict stop a push; a skipped review does not, and is reported as owed. */
export function reviewerBlocks(result: ReviewerResult): boolean {
    return result.outcome === 'findings' || result.outcome === 'unavailable';
}

const PROGRESS_EVERY_MS = 60_000;
const MAX_DELTAS = 4;
const MAX_DELTA_LINES = 400;

/** The reviewer, and one anonymous usage event for what it did (only when the person opted in to telemetry). */
export async function runReviewer(cwd: string, base: string, config: Config, exec: Exec = defaultExec, progress: Progress = message => process.stderr.write(`${message}\n`), options: ReviewerOptions = {}): Promise<ReviewerResult> {
    const result = await review(cwd, base, config, exec, progress, options);
    await trackUsage('reviewer_completed', reviewerUsage(result, options.trigger ?? (options.reviewsBefore ? 'backtest' : 'review')));
    return result;
}

async function review(cwd: string, base: string, config: Config, exec: Exec, progress: Progress, options: ReviewerOptions): Promise<ReviewerResult> {
    const settings = resolveReviewer(config, { ...options.choice, ...(options.full ? { mode: 'full' as const } : {}) });
    const trigger = options.trigger ?? (options.reviewsBefore ? 'backtest' : 'review');
    const git = async (args: string[]) => (await exec('git', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
    const head = await git(['rev-parse', 'HEAD']);
    const baseSha = await git(['rev-parse', `${base}^{commit}`]);
    const branch = options.branch ?? await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const repoRoot = (await git(['rev-parse', '--show-toplevel'])) || cwd;
    let attempts: VerdictStore | undefined;
    // What was asked, from the first line: every verdict, a review that never ran included, says what was asked and what ran.
    let modeRecord: ModeRecord = askedOnly(settings);
    // A review that ends without a verdict says why where the person looks (status, Studio, MCP), not only in a log.
    const none = (outcome: 'unavailable' | 'skipped', reason: string, extra: Partial<ReviewerResult> = {}): ReviewerResult => {
        if (attempts && branch !== 'HEAD') attempts.recordAttempt(branch, { head, outcome, reason, at: new Date().toISOString() });
        return { outcome, items: [], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [], reason, reviewers: [], cached: false, ...extra, mode: { ...modeRecord, ...extra.mode, ran: 'none' } };
    };
    if (!head || !baseSha) return none('unavailable', `not a repository, or ${base} is unknown`);
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return none('unavailable', 'no git directory to keep verdicts in');
    attempts = store;

    const candidates = settings.reviewers.filter(isReviewerName);
    const installed = new Map<ReviewerName, Installed>();
    for (const name of candidates) {
        if (name === 'api') {
            // The API judge is installed when the team configured it and the key it names is set.
            if (settings.api && process.env[settings.api.key_env]) installed.set('api', { binary: 'api', version: settings.api.model });
            continue;
        }
        const found = await resolveAdapter(ADAPTERS[name], cwd, exec);
        if (found) installed.set(name, found);
    }
    const vendorOf = (name: ReviewerName) => (name === 'api' ? apiVendor(settings.api) : ADAPTERS[name].vendor);
    const authors = vendorsOf(await git(['log', '--format=%(trailers:key=Co-Authored-By,valueonly)%(trailers:key=Co-authored-by,valueonly)', `${baseSha}..HEAD`]));
    const mode: ReviewMode = settings.mode;
    let reviewers = selectReviewers(candidates, mode, authors, new Set(installed.keys()), settings.judges, vendorOf);
    if (reviewers.length === 0) return none('unavailable', `no reviewer installed: ${candidates.map(n => ADAPTERS[n].binary).join(', ') || 'review.reviewer.reviewers is empty'}`);
    modeRecord = modeRan(settings, reviewers, candidates, installed);
    if (reviewers.length < 2 && mode === 'full' && (settings.required.panel || settings.required.mode)) {
        return none('unavailable', `rigour.yml requires two reviewers from different vendors, and ${modeRecord.degraded}`, { reviewers, mode: modeRecord });
    }

    const gh = options.blind ? undefined : ghFor(cwd, exec, await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec));
    const found = gh ? await findPullRequest(gh, branch, head, options.pr) : {};
    if (found.error) return none('unavailable', found.error, { reviewers });
    const pr = found.pr;
    if (trigger === 'push' && !options.full && !options.force) {
        const skip = skipReason(settings.on_push, branch, pr);
        if (skip) return none('skipped', skip, { reviewers, pr: pr?.number });
    }
    let reviews: HumanReviews = { markdown: 'none\n', key: '', count: 0 };
    if (gh && pr) {
        const read = await humanReviews(gh, pr, options.reviewsBefore);
        if (read.error) return none('unavailable', read.error, { reviewers, pr: pr.number });
        reviews = read.reviews!;
    }
    const stateRoot = options.stateRoot ?? cwd;
    // Dismissals count only where the team allows them; otherwise the file, if any, is ignored.
    const dismissals = settings.dismissals ? readReviewDismissals(stateRoot) : [];
    // A backtest sees the description as it read at the review, never a later edit describing later code.
    const body = gh && pr && options.reviewsBefore
        ? (await bodyAsOf(gh, pr.number, options.reviewsBefore)) ?? '(the description as of this review could not be recovered: judge claims against the code and its comments only)\n'
        : pr?.body || '(no pull request description)\n';
    const rules = rulesText(cwd);
    const previous = branch !== 'HEAD' ? store.branchState(branch) : undefined;
    // The same commit, asked again with the same settings and reviews (the background run, then the person): the verdict it already has.
    const inputsKey = sha([PROMPT_VERSION, rules, body, reviews.key, JSON.stringify([settings.mode, settings.panel, settings.judges, settings.escalate, settings.panel_max_items, settings.cross_models, settings.models, candidates]), [...installed].map(([n, i]) => `${n} ${i.version}`).join(';')]);
    if (!options.force && previous?.head === head && previous.inputsKey === inputsKey && fs.existsSync(store.decidedPath(previous.verdict))) {
        const verdict = store.readJson<Verdict & { inputs?: { mode?: ModeRecord; reviewers?: ReviewerName[] } }>(previous.verdict);
        const decided = store.readJson<Decided>(store.decidedPath(previous.verdict));
        if (verdict && decided) {
            // The record written with that verdict; a verdict from before records has none.
            const recordPath = store.recordPath(previous.verdict);
            const record = store.readJson<ReviewRecord>(recordPath);
            return { ...result(redismiss(decided, dismissals), verdict, verdict.inputs?.reviewers ?? reviewers, previous.mode, 'same commit and inputs as the last verdict', true, reviews, pr, verdict.inputs?.mode ?? modeRecord, settings.dismissals), ...(record ? { record, recordPath } : {}) };
        }
    }
    // What the team already knows, for every judge; built once, and its risk count decides escalation.
    const fullDiff = (await exec('git', ['diff', `${baseSha}...HEAD`], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
    const previousIsAncestor = !!previous && previous.head !== head && fs.existsSync(previous.verdict) && (await exec('git', ['merge-base', '--is-ancestor', previous.head, 'HEAD'], { cwd, timeoutMs: GH_TIMEOUT_MS })).exitCode === 0;
    const sincePrevious = previousIsAncestor ? new Set((await git(['diff', '--name-only', `${previous!.head}..HEAD`])).split('\n').filter(Boolean)) : new Set<string>();
    const changedFiles = [...fullDiff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map(m => m[1]);
    const context = buildContext({
        cwd, stateRoot, dismissals, diff: fullDiff, router: config.gates.deep?.router, lessons: config.gates.deep?.review_lessons, ...(pr ? { pr: pr.number } : {}), touched: sincePrevious, checks: options.checks ?? [],
        previousPanel: previousIsAncestor ? store.readJson<Verdict>(previous!.verdict)?.panel?.items : undefined,
        docs: await relatedDocs(cwd, changedFiles, exec),
    });
    // escalate: risk. More judges only where a second opinion can change the outcome; the --full hard stop always gets them.
    if (settings.escalate === 'risk' && reviewers.length > 1 && !options.full) {
        const escalation = escalationFor(reviews.count, context.risky);
        if (!escalation.escalate) reviewers = reviewers.slice(0, 1);
        modeRecord = { ...modeRecord, ...(escalation.escalate ? {} : { ran: 'single' as const }), escalation: escalation.why };
    }
    const reviewerVersions = reviewers.map(name => `${name} ${installed.get(name)!.version}`).join(';');
    // What changes the instructions themselves; the context pack changes with every commit, so it is in the fingerprint, not here.
    const rulesHash = sha([reviewerVersions, PROMPT_VERSION, rules, body, reviews.key]);

    // Full or delta.
    const mergedBase = await mergesBaseIn(cwd, baseSha, exec);
    let scope: 'full' | 'delta' = 'full';
    let why: string;
    if (options.full) why = 'full review requested';
    else if (!previous || !fs.existsSync(previous.verdict)) why = `no earlier verdict on ${branch}`;
    else if (previous.head !== head && !previousIsAncestor) why = `last reviewed commit ${previous.head.slice(0, 9)} is not an ancestor (rebase or amend)`;
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
    const fingerprint = sha([head, baseSha, scope, modeRecord.ran, context.key, inputsKey, reviewerVersions, previousVerdictText]);
    const verdictFile = store.verdictPath(head, fingerprint);
    const openFile = store.openPath(verdictFile);
    const previousOpen = scope === 'delta' ? store.readJson<OpenItem[]>(store.openPath(previous!.verdict)) ?? [] : undefined;

    const verify = checkoutVerifier(cwd);
    const modelFor = (name: ReviewerName) => settings.models[name] ?? (name === 'claude' ? settings.model : undefined);
    // The record of the review, written beside the verdict once and rebuilt from the same verdict on a cached read.
    const withRecord = (accounted: Decided, verdict: Verdict, cached: boolean): ReviewerResult => {
        const res = result(accounted, verdict, reviewers, scope, why, cached, reviews, pr, modeRecord, settings.dismissals);
        const judges = (verdict.reviewers ?? []).map(r => ({ reviewer: r.reviewer, ...(installed.get(r.reviewer as ReviewerName)?.version ? { version: installed.get(r.reviewer as ReviewerName)!.version } : {}), ...(modelFor(r.reviewer as ReviewerName) ? { model: modelFor(r.reviewer as ReviewerName) } : {}), ...(typeof r.cost_usd === 'number' ? { cost_usd: r.cost_usd } : {}), ...(r.trace?.turns ? { turns: r.trace.turns } : {}) }));
        const recordPath = store.recordPath(verdictFile);
        const record = (cached && store.readJson<ReviewRecord>(recordPath)) || buildRecord({ head, base: baseSha, scope, verdict, accounted, judges, lessonsServed: context.lessons, humanReviews: reviews.count });
        if (!cached || !fs.existsSync(recordPath)) store.writeJson(recordPath, record);
        return { ...res, record, recordPath };
    };
    if (!options.force && fs.existsSync(verdictFile) && fs.existsSync(openFile)) {
        const verdict = store.readJson<Verdict>(verdictFile)!;
        return withRecord(decide(verdict, previousOpen, verify, dismissals), verdict, true);
    }

    // The daily caps, before any judge starts: a cached or reused verdict above cost nothing and never reaches here.
    const over = overBudget(store.spend(), settings, reviewers.length);
    if (over) return none(settings.required.panel || settings.required.mode ? 'unavailable' : 'skipped', over, { reviewers, scope, why, pr: pr?.number });

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-reviewer-'));
    // One judge run, by CLI or by API: the same prompt, the same cost accounting, the same trace.
    let inlineInputs: Array<{ path: string; text: string }> = [];
    const runJudge = (name: ReviewerName, prompt: string, model: string | undefined) => name === 'api'
        ? runApiJudge(prompt, { url: settings.api!.url, model: settings.api!.model, key: process.env[settings.api!.key_env] ?? '', maxTurns: settings.api!.max_turns, timeoutMs: settings.timeout_ms, cwd, roots: [cwd, work], inputs: inlineInputs, ...(settings.reasoning[name] ? { reasoning: settings.reasoning[name] } : {}), ...(options.fetch ? { fetchImpl: options.fetch } : {}) })
        : exec(installed.get(name)!.binary, ADAPTERS[name].args(prompt, model, { reasoning: settings.reasoning[name] }), { cwd, timeoutMs: settings.timeout_ms, unset: judgeUnset(name, settings.judge_env) });
    try {
        const file = (name: string, text: string) => {
            const target = path.join(work, name);
            fs.writeFileSync(target, text);
            return target;
        };
        const reviewsFile = file('previous-reviews.md', reviews.markdown);
        const prBodyFile = file('pr-description.md', body);
        const diffstatFile = file('diffstat.txt', await git(['diff', '--stat', `${baseSha}...HEAD`]));
        const diffFile = file('full.diff', fullDiff);
        const contextFile = file('team-knowledge.md', context.text);
        const hintsFile = file('hints.txt', options.hints?.trim() || 'none\n');
        inlineInputs = [[reviewsFile, reviews.markdown], [prBodyFile, body], [diffstatFile, await git(['diff', '--stat', `${baseSha}...HEAD`])], [diffFile, fullDiff], [contextFile, context.text], [hintsFile, options.hints?.trim() || 'none\n']].map(([p, text]) => ({ path: p, text }));
        let delta = '';
        // A reviewer must report on the human reviews, unless every point was settled by the previous verdict and is carried.
        let needsPriorPoints = reviews.count > 0;
        if (scope === 'delta') {
            const previousOpenFile = file('previous-open.json', JSON.stringify(previousOpen, null, 2));
            const commitsFile = file('delta-commits.txt', await git(['log', '--format=%h %s', `${previous!.head}..HEAD`]));
            const deltaDiffFile = file('delta.diff', (await exec('git', ['diff', `${previous!.head}..HEAD`], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout);
            // Human points the previous verdict resolved, whose files the new commits leave alone, are not judged again.
            const settled = (store.readJson<Verdict>(previous!.verdict)?.prior_points ?? []).filter(p => p.resolved && !evidenceTouched(p.evidence, sincePrevious));
            const settledFile = file('previous-resolved.json', JSON.stringify(settled, null, 2));
            delta = deltaBlock(previous!.head, previous!.verdict, previousOpenFile, commitsFile, deltaDiffFile, settledFile);
            if (settled.length) needsPriorPoints = false;
        }
        let merge = '';
        if (mergedBase) {
            const impact = await mergeImpact(cwd, await git(['merge-base', 'HEAD^1', 'HEAD^2']), 'HEAD^2', 'HEAD', exec);
            merge = mergeBlock(base, impact ? file('merge-impact.md', impact) : undefined);
        }
        const prompt = renderPrompt({ repoRoot, branch, head: head.slice(0, 9), base, baseSha, mode: scope, reviewsFile, humanCount: reviews.count, prBodyFile, diffstatFile, diffFile, hintsFile, contextFile, deltaBlock: delta, mergeBlock: merge });
        progress(`Rigour reviewer: reviewing ${head.slice(0, 9)} against ${base} (${scope}: ${why}; ${reviews.count} human review(s), written by ${[...authors].join(', ') || 'a person'}) with ${reviewers.join(', ')}`);
        const started = Date.now();
        const ticker = setInterval(() => progress(`Rigour reviewer: still working (${Math.round((Date.now() - started) / 60_000)} min)`), PROGRESS_EVERY_MS);
        let parts: Verdict[];
        try {
            const answers = await Promise.all(reviewers.map(async name => {
                const adapter = ADAPTERS[name];
                const ask = async () => {
                    const run = await runJudge(name, prompt, modelFor(name));
                    progress(`Rigour reviewer: ${name} finished in ${Math.round((Date.now() - started) / 1000)}s (exit ${run.exitCode})`);
                    const answer = adapter.answer(run.stdout);
                    store.addSpend(1, answer.costUsd); // every run counts against the caps, an answer or not
                    return { run, answer, verdict: run.exitCode === 0 || answer.text.trim() ? parseVerdict(answer.text, needsPriorPoints, name, answer) : undefined };
                };
                let first = await ask();
                // No verdict, whether a malformed answer or a run that died, is a slip, not a decision: asked once more, inside the caps.
                if ((!first.verdict || 'error' in first.verdict) && !overBudget(store.spend(), settings, 1)) {
                    progress(`Rigour reviewer: ${name} gave no ${first.verdict ? 'valid verdict' : 'answer'}; asking once more`);
                    first = await ask();
                }
                return first.verdict ?? { error: `${name}: no answer (exit ${first.run.exitCode}): ${first.run.stderr.trim().slice(-200)}` };
            }));
            // A judge that gives nothing is replaced by the next one installed, so the boundary stays up: a review ends unavailable only when every judge failed.
            const spare = candidates.filter(c => installed.has(c) && !reviewers.includes(c));
            for (let i = 0; i < answers.length; i++) {
                let answer = answers[i];
                while ('error' in answer && spare.length && !overBudget(store.spend(), settings, 1)) {
                    const next = spare.shift()!;
                    progress(`Rigour reviewer: ${reviewers[i]} gave no verdict (${answer.error}); ${next} judges instead`);
                    modeRecord = { ...modeRecord, degraded: `${modeRecord.degraded ? `${modeRecord.degraded}; ` : ''}${reviewers[i]} gave no verdict, ${next} judged instead` };
                    reviewers[i] = next;
                    const run = await runJudge(next, prompt, modelFor(next));
                    const got = ADAPTERS[next].answer(run.stdout);
                    store.addSpend(1, got.costUsd);
                    answer = run.exitCode === 0 || got.text.trim() ? parseVerdict(got.text, needsPriorPoints, next, got) : { error: `${next}: no answer (exit ${run.exitCode}): ${run.stderr.trim().slice(-200)}` };
                }
                answers[i] = answer;
            }
            const failed = answers.find(a => 'error' in a);
            if (failed && 'error' in failed) return none('unavailable', failed.error, { reviewers, scope, why, pr: pr?.number });
            parts = answers.map(a => (a as { verdict: Verdict }).verdict);
            for (const part of parts) {
                if (part.trace) labelReads(part.trace, work, changedFiles);
                attachServedRules(part, context.rules);
            }
        } finally {
            clearInterval(ticker);
        }
        const merged = mergeVerdicts(parts); // one part too: every item is tagged with who found it
        const touched = scope === 'delta' ? sincePrevious : new Set<string>();
        let verdict = scope === 'delta' ? carryResolved(merged, store.readJson<Verdict>(previous!.verdict), touched) : merged;
        if (modeRecord.ran === 'panel' && parts.length > 1) {
            // Each judge's own blocking items, unmerged: the panel groups them into findings and decides each one.
            const judgeItems = parts.map(part => account({ ...part, prior_points: [], carried: [], resolved_previous: [] }, undefined, verify).open);
            const previousPanel = scope === 'delta' ? store.readJson<Verdict>(previous!.verdict)?.panel : undefined;
            const cross: Array<{ reviewer: string; cost_usd?: number; tokens?: Tokens }> = [];
            let reserved = 0;
            const items = await runPanel({
                judges: parts.map(part => part.reviewer!),
                items: judgeItems,
                // Only what judges actually disagreed on: a finding parked by the item cap was never asked.
                previousDisputed: (previousPanel?.items ?? []).filter(d => d.status === 'disputed' && d.cross?.length).map(d => d.item),
                evidenced: text => evidenceNames(text).some(([file, line]) => verify(file, line)),
                touched,
                maxItems: settings.panel_max_items,
                // Judges cross-examine at the same time: a run is reserved when allowed, so together they never pass the cap.
                capped: () => {
                    const spent = store.spend();
                    const reason = overBudget({ ...spent, runs: spent.runs + reserved }, settings, 1);
                    if (!reason) reserved++;
                    return reason;
                },
                ask: async (judge, asked) => {
                    const name = judge as ReviewerName;
                    const run = await runJudge(name, crossExamPrompt(repoRoot, head.slice(0, 9), diffFile, asked), settings.cross_models[name] ?? modelFor(name));
                    const answer = ADAPTERS[name].answer(run.stdout);
                    store.addSpend(1, answer.costUsd);
                    reserved--;
                    cross.push({ reviewer: `${name} cross-exam`, ...(answer.costUsd !== undefined ? { cost_usd: answer.costUsd } : {}), ...(answer.tokens ? { tokens: answer.tokens } : {}) });
                    progress(`Rigour reviewer: ${name} cross-examined ${asked.length} finding(s) (exit ${run.exitCode})`);
                    return parseAnswers(answer.text);
                },
            });
            verdict = { ...verdict, panel: { judgeItemIds: judgeItems.flat().map(item => item.id), items }, reviewers: [...(verdict.reviewers ?? []), ...cross] };
        }
        const accounted = decide(verdict, previousOpen, verify, dismissals);
        store.writeJson(verdictFile, { ...verdict, inputs: { head, base: baseSha, scope, why, mode: modeRecord, reviewers, versions: reviewerVersions, authors: [...authors], fingerprint, human_reviews: reviews.count, reviews_before: options.reviewsBefore ?? null, since: previous?.head ?? null, at: new Date().toISOString() } });
        store.writeJson(openFile, accounted.open);
        store.writeJson(store.decidedPath(verdictFile), accounted);
        if (branch !== 'HEAD') store.recordBranch(branch, { head, verdict: verdictFile, mode: scope, rulesHash, reviewsKey: reviews.key, inputsKey });
        return withRecord(accounted, verdict, false);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** The accounting a verdict leads to: with a panel, only what it confirmed blocks; a finding the team dismissed never blocks. */
function decide(verdict: Verdict, previousOpen: OpenItem[] | undefined, verify: (file: string, line: number | undefined) => boolean, dismissals: ReviewDismissal[]): Decided {
    const accounted = account(verdict, previousOpen, verify);
    // An item an earlier round confirmed stays open until it is resolved with evidence, whatever this panel says of it.
    const earlier = new Set((previousOpen ?? []).map(item => item.id));
    const decided = verdict.panel
        ? applyPanel(accounted, new Set(verdict.panel.judgeItemIds.filter(id => !earlier.has(id))), verdict.panel.items.filter(d => !earlier.has(d.item.id)))
        : { ...accounted, disputed: [], dropped: [] };
    return redismiss({ ...decided, dismissed: [] }, dismissals);
}

/** A finding the team dismissed leaves what blocks, now: at decision time and when a stored decision is read again. */
function redismiss(decided: Decided, dismissals: ReviewDismissal[]): Decided {
    const dismissed = decided.open.filter(item => dismissedAs(item, dismissals));
    return dismissed.length ? { ...decided, open: decided.open.filter(item => !dismissed.includes(item)), dismissed: [...decided.dismissed, ...dismissed] } : decided;
}

/** Every `file:line` an answer quotes. */
function evidenceNames(text: string): Array<[string, number]> {
    return [...text.matchAll(/([\w./-]+\.[A-Za-z0-9]+):(\d+)/g)].map(m => [m[1], Number(m[2])]);
}

type Decided = Accounting & { disputed: OpenItem[]; dropped: OpenItem[]; dismissed: OpenItem[] };

/** Why the caps leave no room for `planned` more runs today, or nothing when they do. */
function overBudget(spent: { runs: number; usd: number }, caps: { max_runs_per_day?: number; max_usd_per_day?: number }, planned: number): string | undefined {
    if (caps.max_runs_per_day !== undefined && spent.runs + planned > caps.max_runs_per_day) return `the daily run cap is reached: ${spent.runs} of ${caps.max_runs_per_day} agent runs used today in this repository, and this needs ${planned} more (review.reviewer.max_runs_per_day)`;
    if (caps.max_usd_per_day !== undefined && spent.usd >= caps.max_usd_per_day) return `the daily cost cap is reached: $${spent.usd.toFixed(2)} of $${caps.max_usd_per_day.toFixed(2)} reported today in this repository (review.reviewer.max_usd_per_day)`;
    return undefined;
}

/** Whether a risk-escalated review adds judges: a human review exists, or the router finds a risky changed function. */
function escalationFor(humanReviews: number, risky: number | undefined): { escalate: boolean; why: string } {
    if (humanReviews > 0) return { escalate: true, why: `${humanReviews} human review(s) to check` };
    if (risky === undefined) return { escalate: true, why: 'the risk router could not score this change, so every judge reviews it' };
    return risky > 0
        ? { escalate: true, why: `${risky} risky changed function(s)` }
        : { escalate: false, why: 'no risky changed function and no human review: one judge (review.reviewer.escalate: risk)' };
}

/** What was asked and where the choice came from, before anything has run. */
function askedOnly(settings: ResolvedReviewer): ModeRecord {
    const asked = settings.panel ? 'panel' : settings.mode;
    const source = settings.panel ? settings.source.panel : settings.source.mode;
    return { asked, ran: asked, source, ...(settings.refused.length ? { refused: settings.refused } : {}) };
}

/** The mode asked for and the one the installed reviewers allow: a panel or full review needs two vendors. */
function modeRan(settings: ResolvedReviewer, reviewers: ReviewerName[], candidates: ReviewerName[], installed: Map<ReviewerName, Installed>): ModeRecord {
    const record = askedOnly(settings);
    if (settings.mode !== 'full' || reviewers.length >= settings.judges) return record;
    const missing = candidates.filter(name => !installed.has(name)).map(name => ADAPTERS[name].binary);
    const degraded = `${settings.judges} judges asked, ${reviewers.join(' and ')} could run (${missing.length ? `not installed: ${missing.join(', ')}` : 'no other vendor in review.reviewer.reviewers'})`;
    return { ...record, ran: reviewers.length > 1 ? record.asked : 'single', degraded };
}

/**
 * Before any checkout or typed review: whether this push gets a model review at all (an open, ready
 * pull request, `on_push`). The background job asks first, so a push nobody will read costs one lookup.
 */
export async function pushReviewSkip(cwd: string, branch: string, head: string, config: Config, exec: Exec = defaultExec): Promise<string | undefined> {
    const settings = resolveReviewer(config);
    const gh = ghFor(cwd, exec, await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec));
    const found = await findPullRequest(gh, branch, head, undefined);
    if (found.error) return undefined; // the review itself reports a lookup that failed, as unavailable
    return skipReason(settings.on_push, branch, found.pr);
}

/** Why no model is asked at this push: `review.reviewer.on_push` and whether someone will read the push (an open, non-draft pull request). */
/** What each tool call of a run read: one of Rigour's own input files, a file the change touched, another file, git, or a search. */
function labelReads(trace: RunTrace, work: string, changed: string[]): void {
    const touched = new Set(changed);
    for (const call of trace.calls) {
        const target = call.target.replace(/\\/g, '/');
        call.category = target.startsWith(work.replace(/\\/g, '/')) ? 'rigour-input'
            : call.tool === 'Bash' && /^git\b/.test(target) ? 'git'
                : call.tool === 'Grep' || call.tool === 'Glob' ? 'search'
                    : call.tool === 'Read' ? ([...touched].some(f => target.endsWith(`/${f}`) || target === f) ? 'changed-file' : 'other-file')
                        : 'other';
    }
}

function skipReason(onPush: 'background' | 'wait' | 'off', branch: string, pr: PullRequest | undefined): string | undefined {
    if (onPush === 'off') return 'review.reviewer.on_push is off: run `rigour review --reviewer`';
    if (!pr) return `no pull request for ${branch} yet; the review runs once one is open and ready, or now with \`rigour review --reviewer\``;
    if (pr.draft) return `pull request #${pr.number} is a draft; the review runs once it is ready, or now with \`rigour review --reviewer\``;
    if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
    return undefined;
}


function result(accounted: Decided, verdict: Verdict, reviewers: ReviewerName[], scope: 'full' | 'delta', why: string, cached: boolean, reviews: HumanReviews, pr: PullRequest | undefined, mode: ModeRecord, dismissable: boolean): ReviewerResult {
    const cost = (verdict.reviewers ?? []).map(r => r.cost_usd).filter((c): c is number => typeof c === 'number');
    const used = (verdict.reviewers ?? []).map(r => r.tokens).filter((t): t is Tokens => !!t);
    return {
        outcome: accounted.open.length ? 'findings' : 'passed',
        items: accounted.open,
        unverified: accounted.unverified,
        resolved: accounted.resolved,
        answerInReply: accounted.answerInReply,
        notes: accounted.notes,
        advisory: accounted.advisory,
        disputed: accounted.disputed,
        dropped: accounted.dropped,
        dismissed: accounted.dismissed,
        ...(verdict.panel ? { panel: verdict.panel.items } : {}),
        reviewers,
        scope,
        why,
        ...(cost.length ? { costUsd: cost.reduce((a, b) => a + b, 0) } : {}),
        ...(used.length ? { tokens: used.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output }), { input: 0, output: 0 }) } : {}),
        runs: (verdict.reviewers ?? []).length,
        ...(verdict.rules?.length ? { rules: { checked: verdict.rules.length, followed: verdict.rules.filter(r => r.status === 'followed').length, broken: verdict.rules.filter(r => r.status === 'broken').length, notApplicable: verdict.rules.filter(r => r.status === 'not-applicable').length } } : {}),
        mode,
        dismissable,
        cached,
        ...(reviews.label ? { previousReview: reviews.label } : {}),
        ...(pr ? { pr: pr.number } : {}),
    };
}
