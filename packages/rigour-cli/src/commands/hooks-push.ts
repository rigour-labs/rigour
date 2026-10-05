/**
 * `rigour hooks push --stdin`: the gate before an agent's `git push` (Claude Code PreToolUse on
 * Bash). Everything a push should pass, on what the branch changed since it left main, committed,
 * uncommitted and new files alike:
 *   - the review's findings that must be fixed (as at stop: critical, proven high, security, dead
 *     code), migrations out of order, a merge conflict with main and mentions of deleted files;
 *   - the repository's own formatter, linter, type checker and related tests (review/toolchain.ts);
 *   - the fresh reviewer, when review.reviewer.enabled (review/reviewer.ts).
 * Exit 2 blocks the push and tells the agent each failure; the full output goes to a log file.
 * Any other Bash command, or `git push --dry-run`, passes untouched.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    blocksStop, branchBase, branchFailures, diffFromGit, mergeBaseOf, reviewChange, reviewerBlocks, runReviewer, runToolchain,
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
    const branch = branchBase(repo);
    if (!branch) return { exitCode: 0, message: '' }; // no main branch to measure against: nothing to gate
    const base = mergeBaseOf(repo, branch.mainRef);
    const config = await loadHookConfig(repo);
    const failures = await gates(repo, base, branch.mainRef, config);
    if (failures.lines.length === 0) return { exitCode: 0, message: '' };
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
    const review = await reviewChange({ cwd: repo, config, diff, source });
    const mustFix = [...review.findings, ...review.advisory].filter(f => blocksStop(f) || f.id === 'migration-order');
    mustFix.push(...branchFailures(repo, base, mainRef, config));
    for (const f of mustFix) lines.push(`- ${finding(f)}`);
    for (const tool of await runToolchain(repo, Object.keys(review.changedLines), config)) {
        if (tool.status === 'fail') {
            lines.push(`- ${tool.tool} failed: ${tool.command}`);
            log.push(`## ${tool.tool}: ${tool.command}\n${tool.output ?? ''}`);
        }
    }
    if (config.review?.reviewer?.enabled) {
        const reviewer = await runReviewer(repo, baseName, config);
        if (reviewerBlocks(reviewer)) lines.push(...reviewerLines(reviewer));
    }
    return { lines, log };
}

function finding(f: Failure): string {
    return `[${(f.severity ?? 'medium').toUpperCase()}] ${f.files?.[0] ?? '?'}:${f.line ?? '?'} ${f.title}${f.hint ? ` (fix: ${f.hint})` : ''}`;
}

function reviewerLines(result: ReviewerResult): string[] {
    if (!result.verdict) return [`- reviewer gave no verdict: ${result.error}`];
    return [
        ...result.verdict.prior_points.filter(p => !p.resolved).map(p => `- previous review point still open: ${p.point}${p.evidence ? ` (${p.evidence})` : ''}`),
        ...result.verdict.blocking.map(b => `- reviewer, blocking: ${b.file}${b.line ? `:${b.line}` : ''} ${b.issue}`),
    ];
}

/** A real push: `git push` (also `git -C dir push`), not a dry run. */
export function isPush(command: string): boolean {
    return /\bgit\b(?:\s+-C\s+\S+)?\s+push\b/.test(command) && !/--dry-run\b/.test(command);
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
