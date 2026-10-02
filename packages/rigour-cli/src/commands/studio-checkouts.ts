/**
 * One repository, every checkout of it: agents often work in git worktrees, and each checkout
 * keeps its own .rigour/. Studio and doctor read them together so "this repository" means all of
 * them; a folder that is not a git repository is read alone.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { listOpenFindings, readAgentEvents, readLedger, readStories, type AgentEvent, type LedgerEntry, type Story } from '@rigour-labs/core';

export function checkoutRoots(cwd: string): string[] {
    const list = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const roots = list.status === 0
        ? list.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length).trim())
        : [];
    const self = path.resolve(cwd);
    return [...new Set([self, ...roots.filter(root => fs.existsSync(path.join(root, '.rigour')))])];
}

export function eventsAcross(roots: string[]): AgentEvent[] {
    return roots.flatMap(readAgentEvents).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
}

/**
 * Every problem fixed before a PR: fixes captured from findings (stories.jsonl) and functions an
 * agent fixed in a pre-PR review (the review ledger, with the agent's note saying what it fixed).
 */
export function storiesAcross(roots: string[]): Story[] {
    const seen = new Set<string>();
    const ledgerFixes = roots.flatMap(readLedger).filter(e => e.verdict === 'fixed').map(reviewFixStory);
    return [...roots.flatMap(root => readStories(root)), ...ledgerFixes]
        .filter(s => !seen.has(s.id) && seen.add(s.id))
        .sort((a, b) => a.at.localeCompare(b.at));
}

/** A review-ledger fix as a story: no diff (the ledger keeps none), the agent's note as the detail. */
export function reviewFixStory(entry: LedgerEntry): Story {
    const id = crypto.createHash('sha256').update(`${entry.file}\0${entry.function}\0${entry.at}`).digest('hex').slice(0, 16);
    const name = /^<anonymous>@\d+$/.test(entry.function) ? 'a function' : `\`${entry.function}\``;
    // The agent's note says what was wrong; its first sentence is the headline, the rest the detail.
    const [headline, ...rest] = (entry.note ?? '').split(/(?<=[.;])\s+/);
    const title = headline && headline.length <= 140 ? `${headline.replace(/[.;]$/, '')} (in ${name})` : `Problem fixed in ${name}`;
    const details = headline && headline.length <= 140 ? rest.join(' ') : entry.note;
    return { id, at: entry.at, stage: 'review', file: entry.file, rule: 'review', title, details: details || undefined, diff: [] };
}

export function openFindingsAcross(roots: string[]): ReturnType<typeof listOpenFindings> {
    return roots.flatMap(listOpenFindings).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
