/**
 * `rigour learn-reviews`: learn from the review comments this repository's
 * developers acted on, so agents get those lessons before the next PR.
 *
 * Reads GitHub (merged PRs, review comments and review bodies) read-only, as the
 * account named by review.github_account or RIGOUR_GITHUB_ACCOUNT (its gh token),
 * else GITHUB_TOKEN, else the gh CLI's active account. Lessons are written to
 * .rigour/review-lessons.json in this clone and go nowhere else.
 */
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import path from 'path';
import { personOf } from './git-identity.js';
import { acceptSuggestedText, scopeLesson, branchBase, decideCompiledCheck, decideLesson, defaultExec, proposeCompiledChecks, readCompiledChecks, suspension, type CompiledCheck, githubToken, learnFromReviews, lessonsPath, pendingDecision, quietBotCandidate, readLessons, type LessonEvidence, type ReviewLesson, ruleWriterFor, ConfigSchema, type Config } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

export interface LearnReviewsOptions {
    since?: string;
    until?: string;
    limit?: string;
    promote?: string;
    reject?: string;
    why?: string;
    list?: boolean;
    /** With --list: also list candidates only review bots raised (hidden by default, and counted). */
    includeBots?: boolean;
    json?: boolean;
    /** Rewrite each new point as the rule behind it with the team's reviewer CLI (memory, never training). */
    rules?: boolean;
    pr?: string;
    /** Propose a deterministic check for every verified lesson a template fits, and list the compiled checks. */
    compile?: boolean;
    /** A person's decision on a compiled check: it runs (approve) or stops (withdraw). */
    approveCheck?: string;
    withdrawCheck?: string;
    /** A person takes the corrected wording a newer version suggested for a lesson they decided. */
    useWording?: string;
    /** A person sets how far a lesson reaches (`to`: file, folder or repo). */
    scope?: string;
    to?: string;
}

export async function learnReviewsCommand(cwd: string, options: LearnReviewsOptions): Promise<void> {
    if (options.promote) return decide(cwd, options.promote, 'accepted', options.why);
    if (options.reject) return decide(cwd, options.reject, 'rejected', options.why);
    if (options.list) return list(cwd, options.json, options.includeBots);
    if (options.useWording) return useWording(cwd, options.useWording);
    if (options.scope) return scope(cwd, options.scope, options.to, options.why);
    if (options.compile) return compile(cwd, options.json);
    if (options.approveCheck) return decideCheck(cwd, options.approveCheck, 'active');
    if (options.withdrawCheck) return decideCheck(cwd, options.withdrawCheck, 'withdrawn');
    try {
        const config = await teamConfig(cwd);
        const writeRules = options.rules ? await ruleWriterFor(cwd, config, defaultExec, line => console.error(chalk.yellow(line))) : undefined;
        if (options.rules && !writeRules) throw new Error('--rules needs a reviewer CLI (claude, codex or cursor-agent) installed, as named in review.reviewer.reviewers.');
        const result = await learnFromReviews(cwd, {
            token: await githubToken(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, defaultExec), repo: originRepo(cwd), since: options.since, until: options.until,
            limit: options.limit ? Number(options.limit) : undefined, mainRef: branchBase(cwd)?.mainRef, writeRules, ...(options.pr ? { pr: Number(options.pr) } : {}), apiUrl: process.env.GITHUB_API_URL,
        });
        if (options.json) return void console.log(JSON.stringify(result, null, 2));
        console.log(chalk.green(`✔ ${options.pr ? `PR #${options.pr}` : `${result.prs} merged PR(s)`}: ${result.candidates.person + result.candidates.bot} new candidate point(s) (${result.candidates.person} under people's logins, ${result.candidates.bot} from review bots); ${result.actedOn} of ${result.comments} review comment(s) acted on before the merge (recorded, not evidence).`));
        const p = result.promoted;
        console.log(`  Lessons on evidence: ${result.verified} (outcome ${p.outcome}, a person's edit of agent work ${p.correction}, a person's decision ${p.person}, recurrence across authors ${p.recurrence}${p.legacy ? `, from before evidence ${p.legacy}` : ''}); ${result.heldBack} held back by counter-evidence; ${result.rejected} rejected.`);
        if (result.rules !== undefined) console.log(`  ${result.rules} written as rules, ${result.notRules} judged no rule (every judgement in .rigour/review-rules-log.jsonl).`);
        console.log(chalk.dim(`  Lessons: ${path.relative(cwd, lessonsPath(cwd)) || lessonsPath(cwd)} (local). Review them with \`rigour learn-reviews --list\`.`));
    } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
    }
}

function list(cwd: string, json?: boolean, includeBots?: boolean): void {
    const all = readLessons(cwd);
    if (json) return void console.log(JSON.stringify(all, null, 2));
    const lessons = includeBots ? all : all.filter(l => !quietBotCandidate(l));
    for (const l of lessons) printLesson(l);
    const hidden = all.length - lessons.length;
    if (hidden) console.log(chalk.dim(`${hidden} candidate(s) from review bots, hidden: --include-bots lists them.`));
    else if (all.length === 0) console.log('No review lessons yet. Run `rigour learn-reviews`.');
}

function printLesson(l: ReviewLesson): void {
    const label = { verified: chalk.green('lesson   '), candidate: chalk.yellow('candidate'), rejected: chalk.red('rejected ') };
    const prs = [...new Set(l.evidence.map(e => `#${e.pr}`))].join(', ');
    const by = chalk.dim(`${l.promotedBy ? ` [${l.promotedBy}]` : ''}${l.scope ? ` [${l.scope === 'repo' ? 'every change' : 'its folder'}]` : ''}`);
    console.log(`${label[l.state]} ${chalk.dim(l.id)} ${l.file || '(team standard)'}: ${l.text}${by} ${chalk.dim(`(${prs})`)}`);
    const pending = pendingDecision(l);
    if (pending) console.log(chalk.yellow(`          ${pendingReason(pending)}`));
    if (l.suggestedText) console.log(chalk.cyan(`          corrected wording (${l.suggestedWhy ?? 'reworded'}): ${l.suggestedText}`) + chalk.dim(`  take it: rigour learn-reviews --use-wording ${l.id}`));
}

/** Why a candidate waits on a person, in the words Studio's chip uses. */
function pendingReason(e: LessonEvidence): string {
    if (e.kind === 'lines') return `a later fix changed its lines: ${e.detail ?? ''}`.trim();
    if (e.kind === 'reclassified') return `back to candidate: ${e.detail ?? ''}`;
    return e.detail ?? 'taken back';
}

/** Proposes checks for the verified lessons a template fits, then lists every compiled check and its state. */
function compile(cwd: string, json?: boolean): void {
    const proposed = proposeCompiledChecks(cwd);
    const checks = readCompiledChecks(cwd);
    if (json) return void console.log(JSON.stringify({ proposed: proposed.map(c => c.id), checks }, null, 2));
    const label = { proposed: chalk.yellow('proposed '), active: chalk.green('active   '), withdrawn: chalk.dim('withdrawn') };
    const lessons = new Map(readLessons(cwd).map(l => [l.id, l]));
    for (const c of checks) {
        const suspended = suspension(c, lessons);
        console.log(`${suspended ? chalk.red('suspended') : label[c.state]} ${chalk.dim(c.id)} ${c.files}: ${c.kind === 'forbid' ? `no \`${c.symbol}\`` : `\`${c.symbol}\` needs \`${c.with}\``} (${c.message})`);
        if (suspended) console.log(chalk.dim(`          ${suspended}`));
        if (c.state === 'proposed' && c.backtest) console.log(chalk.dim(`          ${backtestLine(c.backtest)}`));
    }
    if (checks.length === 0) console.log('No verified lesson fits a check yet: a lesson compiles when it names its file and its symbols in backticks and says never, avoid, instead of, always or must.');
    else if (proposed.length) console.log(`\n${proposed.length} new proposal(s). A proposed check runs only once a person approves it: rigour learn-reviews --approve-check <id>`);
}

/** What the history says about a proposed check: counts, and a rate only from RATE_MIN. */
function backtestLine(b: NonNullable<CompiledCheck['backtest']>): string {
    const share = (s: { fired: number; n: number; rate: number | null }) => `${s.fired} of ${s.n}${s.rate === null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;
    return `fires on ${share(b.repeating)} merged pull request(s) a review found the lesson repeating in; on ${share(b.other)} other merged change(s) to its files`;
}

function decideCheck(cwd: string, id: string, state: 'active' | 'withdrawn'): void {
    try {
        decideCheckOrThrow(cwd, id, state);
    } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exitCode = 1;
    }
}

function decideCheckOrThrow(cwd: string, id: string, state: 'active' | 'withdrawn'): void {
    // Who decided is committed with the check: a decision with no one to name is refused, never recorded empty.
    const by = personOf(cwd);
    if (by === 'unknown') {
        console.error(chalk.red('No git email is set in this checkout (git config user.email): who approves or takes back a compiled check is committed with it.'));
        process.exitCode = 1;
        return;
    }
    const check = decideCompiledCheck(cwd, id, state, by);
    if (!check) {
        console.error(chalk.red(`No compiled check ${id}.`));
        process.exitCode = 1;
        return;
    }
    console.log(state === 'active' ? chalk.green(`✔ Runs from now on (a note unless gates.compiled_lessons.block): ${check.message}`) : chalk.yellow(`✔ Taken back: ${check.message}`));
}

/** A person sets how far a lesson reaches: its file, its folder, or every change (a repository standard). */
function scope(cwd: string, id: string, to: string | undefined, why?: string): void {
    if (to !== 'file' && to !== 'folder' && to !== 'repo') {
        console.error(chalk.red('--to is file, folder or repo.'));
        process.exitCode = 1;
        return;
    }
    let lesson;
    try {
        lesson = scopeLesson(cwd, id, to, personOf(cwd), why);
    } catch (e: any) {
        console.error(chalk.red(e.message));
        process.exitCode = 1;
        return;
    }
    if (!lesson) {
        console.error(chalk.red(`No lesson ${id}.`));
        process.exitCode = 1;
        return;
    }
    const reach = to === 'repo' ? 'every change, as a team standard' : to === 'folder' ? `every change in ${path.posix.dirname(lesson.file)}/` : `changes to ${lesson.file}`;
    console.log(chalk.green(`✔ Reaches ${reach}${lesson.state === 'verified' ? '' : ' once it is a lesson (it is a candidate now)'}: ${lesson.text}`));
}

/** A person takes the suggested wording of a lesson they decided; the old wording is kept as evidence. */
function useWording(cwd: string, id: string): void {
    const lesson = acceptSuggestedText(cwd, id, personOf(cwd));
    if (!lesson) {
        console.error(chalk.red(`No lesson ${id} with a suggested wording.`));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.green(`✔ Now reads: ${lesson.text}`));
}

/** A person's decision, kept as evidence with who made it (their git email) and why. */
function decide(cwd: string, id: string, decision: 'accepted' | 'rejected', why?: string): void {
    const lesson = decideLesson(cwd, id, decision, personOf(cwd), why);
    if (!lesson) {
        console.error(chalk.red(`No lesson ${id}.`));
        process.exitCode = 1;
        return;
    }
    console.log(decision === 'accepted' ? chalk.green(`✔ A lesson now: ${lesson.text}`) : chalk.yellow(`✔ Rejected: ${lesson.text}. The judges are told this team decided against it.`));
}

/** The repository's rigour.yml, or the defaults when it cannot be read (no rigour.yml is the defaults already). */
async function teamConfig(cwd: string): Promise<Config> {
    try {
        return await loadConfig(cwd, {});
    } catch {
        return ConfigSchema.parse({});
    }
}

/** owner/name from the origin remote (https or ssh, any host alias). */
export function originRepo(cwd: string): string {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!match) throw new Error(`Cannot read owner/name from the origin remote: ${url}`);
    return `${match[1]}/${match[2]}`;
}
