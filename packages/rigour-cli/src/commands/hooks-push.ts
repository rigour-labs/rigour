/**
 * `rigour hooks push --stdin`: the gate before an agent's `git push` (Claude Code PreToolUse on
 * Bash). Everything a push should pass, on what the branch changed since it left main, committed,
 * uncommitted and new files alike:
 *   - the review's findings that must be fixed (as at stop: critical, proven high, security, dead
 *     code), migrations out of order, a merge conflict with main and mentions of deleted files;
 *   - the repository's own formatter, linter, type checker and related tests (review/toolchain.ts);
 *   - the reviewer, when review.reviewer.enabled (review/reviewer.ts): with `on_push: wait` the push
 *     waits for its verdict; with `background` (the default) the push goes through once the checks
 *     above pass and the pushed commit is reviewed in a worktree of its own, the verdict reaching
 *     the store, a notification and `rigour review --status`.
 * Exit 2 blocks the push and tells the agent each failure; the full output goes to a log file.
 * Any other Bash command, or `git push --dry-run`, passes untouched.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    branchBase, branchFailures, diffFromGit, itemLine, mergeBaseOf, resolveReviewer, reviewChange, reviewerBlocks, runReviewer, runToolchain, startBackgroundReview,
    type Config, type Failure, type ReviewerResult,
} from '@rigour-labs/core';
import { loadHookConfig } from './hooks-stop.js';

export interface PushGateResult {
    /** 0 lets the push run; 2 blocks it. */
    exitCode: 0 | 2;
    /** What the agent is told when blocked. */
    message: string;
}

export async function hooksPushCommand(stdin: string, fallbackCwd: string): Promise<PushGateResult> {
    const payload = parse(stdin);
    const command = String(payload.tool_input?.command ?? '');
    if (!isPush(command)) return { exitCode: 0, message: '' };
    const repo = repositoryOf(pushTarget(command) ?? payload.cwd ?? fallbackCwd);
    if (!repo) return { exitCode: 0, message: '' };
    return pushGate(repo);
}

/** The gate itself, on the repository's branch against main: shared by the agent hook and git's pre-push (hooks-git.ts). */
export async function pushGate(dir: string): Promise<PushGateResult> {
    const repo = repositoryOf(dir);
    if (!repo) return { exitCode: 0, message: '' };
    const branch = branchBase(repo);
    if (!branch) return { exitCode: 0, message: '' }; // no main branch to measure against: nothing to gate
    const base = mergeBaseOf(repo, branch.mainRef);
    const config = await loadHookConfig(repo);
    const failures = await gates(repo, base, branch.mainRef, config);
    if (failures.lines.length === 0) return { exitCode: 0, message: await backgroundReviewNote(repo, branch.mainRef, config) };
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-push-')), 'gates.log');
    fs.writeFileSync(log, failures.log.join('\n\n'));
    return {
        exitCode: 2,
        message: [`Push blocked: ${failures.lines.length} check(s) failed for ${path.basename(repo)} against ${branch.mainRef.replace(/^refs\/(remotes\/|heads\/)/, '')} (full output: ${log}). Fix each, then push again:`, ...failures.lines].join('\n'),
    };
}

async function gates(repo: string, base: string, mainRef: string, config: Config): Promise<{ lines: string[]; log: string[] }> {
    const baseName = mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
    const lines: string[] = [];
    const log: string[] = [];
    const source = { mode: 'since' as const, commit: base };
    const diff = diffFromGit(repo, source);
    const review = await reviewChange({ cwd: repo, config, diff, source, typed: true });
    // What the review reports is what must be fixed (quiet.ts `mustFix`); the stop hook uses the same set.
    const mustFix = [...review.findings, ...branchFailures(repo, base, mainRef, config)];
    for (const f of mustFix) lines.push(`- ${finding(f)}`);
    // A check that could not run is never a pass: a checkout that cannot prove the change blocks it.
    if (review.status === 'ERROR') for (const id of review.gateErrors) lines.push(`- ${id} could not run${id === 'typed-checks-unavailable' && review.typedError ? `: ${review.typedError}` : ''}`);
    for (const tool of await runToolchain(repo, Object.keys(review.changedLines), config, review.changedLines)) {
        if (tool.status === 'fail') {
            // A tool that names places (the lint overlay, knip) gets one line per place, like a finding.
            lines.push(...(tool.lines?.length ? tool.lines.map(line => `- ${tool.tool}: ${line}`) : [`- ${tool.tool} failed: ${tool.command}`]));
            log.push(`## ${tool.tool}: ${tool.command}\n${tool.output ?? ''}`);
        }
    }
    const settings = resolveReviewer(config);
    if (settings.enabled && settings.on_push === 'wait') {
        const reviewer = await runReviewer(repo, baseName, config, undefined, undefined, { trigger: 'push', hints: review.hints.join('\n') });
        if (reviewerBlocks(reviewer)) lines.push(...reviewerLines(reviewer));
    }
    return { lines, log };
}

/** Once the checks pass: start the model review of the pushed commit without holding the push, and say so. */
async function backgroundReviewNote(repo: string, mainRef: string, config: Config): Promise<string> {
    const reviewer = resolveReviewer(config);
    if (!reviewer.enabled || reviewer.on_push !== 'background') return '';
    const head = gitOutput(repo, ['rev-parse', 'HEAD']);
    const branch = gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!head || !branch || branch === 'HEAD') return '';
    const base = mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
    const log = await startBackgroundReview(repo, { head, branch, base }, [process.execPath, process.argv[1], 'hooks', 'review-background', '--commit', head, '--branch', branch, '--base', base]);
    return log ? `Rigour: the model review of ${head.slice(0, 9)} runs in the background (rigour review --status; log: ${log}). Run \`rigour review --reviewer --full\` before asking for a human review.` : '';
}

function gitOutput(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
}

function finding(f: Failure): string {
    return `[${(f.severity ?? 'medium').toUpperCase()}] ${f.files?.[0] ?? '?'}:${f.line ?? '?'} ${f.title}${f.hint ? ` (fix: ${f.hint})` : ''}`;
}

function reviewerLines(result: ReviewerResult): string[] {
    if (result.outcome === 'unavailable') return [`- reviewer gave no verdict: ${result.reason}`];
    return result.items.map(item => `- reviewer: ${itemLine(item).replace(/\n\s+/g, ' ')}`);
}

/**
 * A real push: `git push` (or `git -C dir push`) where a command starts (the beginning, or after
 * `;`, `&&`, `||`, `|` or a newline), not a dry run. The words inside an argument or a quoted
 * string (`--disallowedTools "Bash(git push:*)"`) are not a push.
 */
export function isPush(command: string): boolean {
    return /(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+push(?:\s|$)/.test(command.trim()) && !/--dry-run\b/.test(command);
}

/** The directory the push runs in: `cd <dir> && git push` or `git -C <dir> push`. */
export function pushTarget(command: string): string | undefined {
    const match = command.match(/(?:^|&&|;|\|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/) ?? command.match(/git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    const dir = match?.slice(1).find(Boolean);
    return dir?.replace(/^~(?=\/|$)/, os.homedir());
}

function repositoryOf(dir: string): string | undefined {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
}

function parse(stdin: string): { cwd?: string; tool_input?: { command?: unknown } } {
    try {
        const parsed = JSON.parse(stdin || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}
