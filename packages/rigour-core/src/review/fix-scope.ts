/**
 * A fix round's scope: the files the branch's own commits changed since the review they answer,
 * less the files that review cited. A fix round changes what the review asked for and nothing
 * else, so every extra file is either a point the reviewer never made or work for a follow-up.
 *
 * Cited means: the path of an inline comment of that review round (every review a person
 * submitted on the same commit), or a tracked file the review text names (`src/a.ts:12`,
 * `a.ts`, a blob link), when the name points at exactly one file. A test of a cited file is in
 * scope when it sits beside it (or in its `__tests__`). Merges are left out (a merge from main brings main's files, not the round's), and so is
 * a file the round changed and then put back.
 */
import path from 'path';
import { defaultExec, githubEnv, parseJsonArrays, type Exec } from './reviewer/exec.js';
import { findPullRequest, ghFor, isHuman } from './reviewer/inputs.js';
import { isTestFile } from './test-files.js';

export interface FixScope {
    pr: number;
    review: { id: number; login: string; submittedAt: string; commit: string };
    cited: string[];
    changed: string[];
    extra: string[];
}

const GIT_TIMEOUT_MS = 60_000;

export async function fixScope(cwd: string, options: { pr: number | undefined; review: number | undefined; githubAccount: string | undefined }, exec: Exec = defaultExec): Promise<{ scope?: FixScope; error?: string }> {
    const git = async (args: string[]) => exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (!head) return { error: 'not a git repository' };
    const gh = ghFor(cwd, exec, await githubEnv(cwd, options.githubAccount, exec));
    const found = await findPullRequest(gh, branch, head, options.pr);
    if (!found.pr) return { error: found.error ?? `no pull request for ${branch}: name one with --scope <number>` };
    const pr = found.pr;
    const reviews = await gh(['api', `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, '--paginate']);
    const comments = await gh(['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`, '--paginate']);
    if (reviews.exitCode !== 0 || comments.exitCode !== 0) return { error: `could not read the reviews of pull request ${pr.number}: ${(reviews.stderr || comments.stderr).trim().slice(0, 200)}` };
    const human = parseJsonArrays(reviews.stdout).filter((r: any) => isHuman(r, pr.author) && r.commit_id);
    const target = options.review !== undefined ? human.find((r: any) => r.id === options.review) : human.at(-1);
    if (!target) return { error: options.review !== undefined ? `no review ${options.review} by a person on pull request ${pr.number}` : `pull request ${pr.number} has no review by a person yet` };
    if ((await git(['merge-base', '--is-ancestor', target.commit_id, 'HEAD'])).exitCode !== 0) {
        return { error: `the reviewed commit ${String(target.commit_id).slice(0, 9)} is not behind HEAD: fetch it, or the branch was rewritten since the review` };
    }
    const round = human.filter((r: any) => r.commit_id === target.commit_id);
    const roundIds = new Set(round.map((r: any) => r.id));
    const inline = parseJsonArrays(comments.stdout).filter((c: any) => isHuman(c, pr.author) && roundIds.has(c.pull_request_review_id));
    const tracked = trackedIndex((await git(['ls-files'])).stdout.split('\n').filter(Boolean));
    const cited = new Set<string>(inline.map((c: any) => String(c.path)));
    for (const text of [...round.map((r: any) => r.body), ...inline.map((c: any) => c.body)]) for (const file of mentioned(String(text ?? ''), tracked)) cited.add(file);
    const changed = await changedByTheRound(git, target.commit_id);
    const covered = (file: string) => cited.has(file) || (isTestFile(file) && [...cited].some(c => subject(c) === subject(file)));
    return {
        scope: {
            pr: pr.number,
            review: { id: target.id, login: target.user.login, submittedAt: String(target.submitted_at ?? ''), commit: target.commit_id },
            cited: [...cited].sort(),
            changed,
            extra: changed.filter(file => !covered(file)),
        },
    };
}

/** Files the branch's own commits (not its merges) changed since `commit`, and that still differ from it. */
async function changedByTheRound(git: (args: string[]) => ReturnType<Exec>, commit: string): Promise<string[]> {
    const own = new Set((await git(['log', '--first-parent', '--no-merges', '--name-only', '--format=', `${commit}..HEAD`])).stdout.split('\n').filter(Boolean));
    const differ = (await git(['diff', '--name-only', commit, 'HEAD'])).stdout.split('\n').filter(Boolean);
    return differ.filter(file => own.has(file)).sort();
}

/** Tracked files by base name, built once for every review text. */
function trackedIndex(files: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const file of files) {
        const base = path.posix.basename(file);
        const same = index.get(base);
        if (same) same.push(file);
        else index.set(base, [file]);
    }
    return index;
}

/** Tracked files a review's text names, by path, path suffix or blob link, when the name is unambiguous. */
function mentioned(text: string, tracked: Map<string, string[]>): string[] {
    const found = new Set<string>();
    for (const raw of text.match(/[\w@$./-]+\.[A-Za-z][\w]*/g) ?? []) {
        const name = raw.replace(/^.*\/blob\/[^/]+\//, '').replace(/^\.\//, '');
        const matches = (tracked.get(path.posix.basename(name)) ?? []).filter(file => file === name || file.endsWith(`/${name}`));
        const exact = matches.find(file => file === name);
        if (exact || matches.length === 1) found.add(exact ?? matches[0]);
    }
    return [...found];
}

/** What a file is about: `src/a.ts`, `src/a.test.ts` and `src/__tests__/a.spec.ts` are all `src/a`. */
function subject(file: string): string {
    const dir = path.posix.dirname(file).replace(/\/(__tests__|tests?)$/, '');
    return path.posix.join(dir, path.posix.basename(file).replace(/\.(test|spec|test-d)(?=\.)/, '').replace(/\.[^.]+$/, ''));
}
