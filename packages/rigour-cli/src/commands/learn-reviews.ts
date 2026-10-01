/**
 * `rigour learn-reviews`: learn from the review comments this repository's
 * developers acted on, so agents get those lessons before the next PR.
 *
 * Reads GitHub (merged PRs and review comments) with GITHUB_TOKEN or the gh
 * CLI's token, read-only. Lessons are written to .rigour/review-lessons.json
 * in this clone and go nowhere else.
 */
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { learnFromReviews, promoteLesson, readLessons } from '@rigour-labs/core';

export interface LearnReviewsOptions {
    since?: string;
    until?: string;
    limit?: string;
    promote?: string;
    list?: boolean;
    json?: boolean;
}

export async function learnReviewsCommand(cwd: string, options: LearnReviewsOptions): Promise<void> {
    if (options.promote) return promote(cwd, options.promote);
    if (options.list) return list(cwd, options.json);
    try {
        const result = await learnFromReviews(cwd, {
            token: githubToken(), repo: originRepo(cwd), since: options.since, until: options.until,
            limit: options.limit ? Number(options.limit) : undefined, apiUrl: process.env.GITHUB_API_URL,
        });
        if (options.json) return void console.log(JSON.stringify(result, null, 2));
        console.log(chalk.green(`✔ ${result.prs} merged PR(s), ${result.comments} review comment(s), ${result.actedOn} acted on.`));
        console.log(`  ${result.added} new lesson(s); ${result.verified} verified (acted on in 2+ PRs); ${result.total} in total.`);
        console.log(chalk.dim('  Lessons: .rigour/review-lessons.json (local). Review them with `rigour learn-reviews --list`.'));
    } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
    }
}

function list(cwd: string, json?: boolean): void {
    const lessons = readLessons(cwd);
    if (json) return void console.log(JSON.stringify(lessons, null, 2));
    for (const l of lessons) {
        const prs = [...new Set(l.evidence.map(e => `#${e.pr}`))].join(', ');
        console.log(`${l.state === 'verified' ? chalk.green('verified ') : chalk.yellow('candidate')} ${chalk.dim(l.id)} ${l.file}: ${l.text} ${chalk.dim(`(${prs})`)}`);
    }
    if (lessons.length === 0) console.log('No review lessons yet. Run `rigour learn-reviews`.');
}

function promote(cwd: string, id: string): void {
    const lesson = promoteLesson(cwd, id);
    if (!lesson) {
        console.error(chalk.red(`No lesson ${id}.`));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.green(`✔ Verified: ${lesson.text}`));
}

function githubToken(): string {
    const fromEnv = process.env.GITHUB_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
        return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        throw new Error('Set GITHUB_TOKEN or sign in with `gh auth login` (read access to the repository is enough).');
    }
}

/** owner/name from the origin remote (https or ssh, any host alias). */
export function originRepo(cwd: string): string {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!match) throw new Error(`Cannot read owner/name from the origin remote: ${url}`);
    return `${match[1]}/${match[2]}`;
}
