/**
 * What the reviewer works from, gathered before any model runs: the pull request (found by
 * branch first, since at push time the commit is not on the forge yet; by commit for a detached
 * checkout such as a backtest; only a number counts), every human review and inline comment
 * (bots and the author excluded; everything from `reviewsBefore` on hidden for a backtest), the
 * description, the diff written to a file (a reviewer whose shell is sandboxed still reads it,
 * and no reviewer spends turns paging it), and whether HEAD merges the base in.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { GH_TIMEOUT_MS, parseJsonArrays, type Exec } from './exec.js';

export interface PullRequest {
    number: number;
    state: 'open' | 'closed' | 'merged';
    draft: boolean;
    author: string;
    body: string;
}

export interface HumanReviews {
    /** As the reviewer reads them, oldest first, inline comments after; `none` when there are none. */
    markdown: string;
    /** Changes when a review or comment is added or edited: part of the verdict fingerprint. */
    key: string;
    count: number;
    /** `<login>, <date> (<n> reviews)` of the latest, for the report. */
    label?: string;
}

type Gh = (args: string[]) => ReturnType<Exec>;

export function ghFor(cwd: string, exec: Exec, env: Record<string, string> | undefined): Gh {
    return args => exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS, env });
}

const PR_FIELDS = 'number,state,isDraft,author,body';

/** The pull request for the branch (or the one named, or the one the commit is on), or none, or why it could not be read. */
export async function findPullRequest(gh: Gh, branch: string, head: string, named: number | undefined): Promise<{ pr?: PullRequest; error?: string }> {
    if (named !== undefined) return viewPullRequest(gh, String(named));
    if (branch !== 'HEAD') {
        const byBranch = await viewPullRequest(gh, branch);
        if (byBranch.pr || !byBranch.error) return byBranch;
        if (!/no pull requests? found|could not resolve/i.test(byBranch.error)) return byBranch;
    }
    const byCommit = await gh(['api', `repos/{owner}/{repo}/commits/${head}/pulls`, '-q', '.[0].number']);
    if (byCommit.exitCode !== 0) return branch === 'HEAD' ? { error: `could not look up the pull request for ${head.slice(0, 9)}: ${byCommit.stderr.trim()}` } : {};
    const number = byCommit.stdout.trim();
    return /^\d+$/.test(number) ? viewPullRequest(gh, number) : {};
}

async function viewPullRequest(gh: Gh, selector: string): Promise<{ pr?: PullRequest; error?: string }> {
    const result = await gh(['pr', 'view', selector, '--json', PR_FIELDS]);
    if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        return /no pull requests? found/i.test(message) ? {} : { error: `could not read the pull request for ${selector}: ${message.slice(0, 200)}` };
    }
    try {
        const parsed = JSON.parse(result.stdout);
        if (!Number.isInteger(parsed.number)) return { error: `gh returned no pull request number for ${selector}` };
        return { pr: { number: parsed.number, state: String(parsed.state ?? '').toLowerCase() as PullRequest['state'], draft: !!parsed.isDraft, author: String(parsed.author?.login ?? ''), body: String(parsed.body ?? '') } };
    } catch {
        return { error: `gh returned something other than a pull request for ${selector}: ${result.stdout.slice(0, 120)}` };
    }
}

/** Every review by a person and every inline comment by a person, hidden from `reviewsBefore` on. */
export async function humanReviews(gh: Gh, pr: PullRequest, reviewsBefore: string | undefined): Promise<{ reviews?: HumanReviews; error?: string }> {
    const reviews = await gh(['api', `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, '--paginate']);
    if (reviews.exitCode !== 0) return { error: `could not read the reviews of pull request ${pr.number}: ${reviews.stderr.trim().slice(0, 200)}` };
    const comments = await gh(['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`, '--paginate']);
    if (comments.exitCode !== 0) return { error: `could not read the comments of pull request ${pr.number}: ${comments.stderr.trim().slice(0, 200)}` };
    const human = (x: any) => x?.user && x.user.type !== 'Bot' && !/\[bot\]$/.test(x.user.login) && x.user.login !== pr.author;
    const before = (at: unknown) => !reviewsBefore || (typeof at === 'string' && at < reviewsBefore);
    const rounds = parseJsonArrays(reviews.stdout).filter((r: any) => human(r) && String(r.body ?? '').trim() && before(r.submitted_at));
    const inline = parseJsonArrays(comments.stdout).filter((c: any) => human(c) && before(c.created_at));
    let markdown = rounds.map((r: any) => `## Review by ${r.user.login}, ${r.submitted_at}, ${r.state} (on ${String(r.commit_id ?? '').slice(0, 9)})\n\n${String(r.body).trim()}\n`).join('\n');
    if (inline.length) markdown += `\n## Inline comments\n${inline.map((c: any) => `- ${c.created_at} ${c.path}:${c.line ?? c.original_line ?? '?'}: ${String(c.body ?? '').trim()}`).join('\n')}\n`;
    const latest = rounds.at(-1);
    return {
        reviews: {
            markdown: markdown || 'none\n',
            key: [...rounds.map((r: any) => `${r.id},${r.submitted_at},${r.commit_id},${r.state}`), ...inline.map((c: any) => `${c.id},${c.updated_at}`)].join('|'),
            count: rounds.length,
            ...(latest ? { label: `${latest.user.login}, ${latest.submitted_at} (${rounds.length} review${rounds.length === 1 ? '' : 's'})` } : {}),
        },
    };
}

/** The repository's rules as the reviewer must read them. */
export function rulesText(cwd: string): string {
    return ['AGENTS.md', 'CLAUDE.md'].map(name => {
        try {
            return fs.readFileSync(path.join(cwd, name), 'utf8');
        } catch {
            return '';
        }
    }).join('\n');
}

export function sha(parts: string[]): string {
    return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/** True when HEAD is a merge whose second parent is on the base: the branch merged main in. */
export async function mergesBaseIn(cwd: string, baseSha: string, exec: Exec): Promise<boolean> {
    const parents = (await exec('git', ['rev-list', '--parents', '-n1', 'HEAD'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim().split(/\s+/);
    if (parents.length <= 2) return false;
    return (await exec('git', ['merge-base', '--is-ancestor', 'HEAD^2', baseSha], { cwd, timeoutMs: GH_TIMEOUT_MS })).exitCode === 0;
}

/** Added and removed lines between two commits. */
export async function linesChanged(cwd: string, from: string, to: string, exec: Exec): Promise<number> {
    const numstat = (await exec('git', ['diff', '--numstat', `${from}..${to}`], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
    return numstat.split('\n').reduce((sum, line) => {
        const [added, removed] = line.split('\t');
        return sum + (Number(added) || 0) + (Number(removed) || 0);
    }, 0);
}
