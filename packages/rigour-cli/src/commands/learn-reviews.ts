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
import { branchBase, decideLesson, defaultExec, githubToken, learnFromReviews, lessonsPath, readLessons, ruleWriterFor, ConfigSchema, type Config } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

export interface LearnReviewsOptions {
    since?: string;
    until?: string;
    limit?: string;
    promote?: string;
    reject?: string;
    why?: string;
    list?: boolean;
    json?: boolean;
    /** Rewrite each new point as the rule behind it with the team's reviewer CLI (memory, never training). */
    rules?: boolean;
    pr?: string;
}

export async function learnReviewsCommand(cwd: string, options: LearnReviewsOptions): Promise<void> {
    if (options.promote) return decide(cwd, options.promote, 'accepted', options.why);
    if (options.reject) return decide(cwd, options.reject, 'rejected', options.why);
    if (options.list) return list(cwd, options.json);
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

function list(cwd: string, json?: boolean): void {
    const lessons = readLessons(cwd);
    if (json) return void console.log(JSON.stringify(lessons, null, 2));
    const label = { verified: chalk.green('lesson   '), candidate: chalk.yellow('candidate'), rejected: chalk.red('rejected ') };
    for (const l of lessons) {
        const prs = [...new Set(l.evidence.map(e => `#${e.pr}`))].join(', ');
        const by = l.promotedBy ? chalk.dim(` [${l.promotedBy}]`) : '';
        console.log(`${label[l.state]} ${chalk.dim(l.id)} ${l.file || '(team standard)'}: ${l.text}${by} ${chalk.dim(`(${prs})`)}`);
    }
    if (lessons.length === 0) console.log('No review lessons yet. Run `rigour learn-reviews`.');
}

/** A person's decision, kept as evidence with who made it (their git email) and why. */
function decide(cwd: string, id: string, decision: 'accepted' | 'rejected', why?: string): void {
    let by = 'unknown';
    try {
        by = execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf8' }).trim() || by;
    } catch {
        // no git identity: recorded as unknown
    }
    const lesson = decideLesson(cwd, id, decision, by, why);
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
