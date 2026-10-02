/**
 * One repository, every checkout of it: agents often work in git worktrees, and each checkout
 * keeps its own .rigour/. Studio and doctor read them together so "this repository" means all of
 * them; a folder that is not a git repository is read alone.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listOpenFindings, readAgentEvents, readStories, type AgentEvent, type Story } from '@rigour-labs/core';

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

export function storiesAcross(roots: string[]): Story[] {
    const seen = new Set<string>();
    return roots.flatMap(root => readStories(root)).filter(s => !seen.has(s.id) && seen.add(s.id)).sort((a, b) => a.at.localeCompare(b.at));
}

export function openFindingsAcross(roots: string[]): ReturnType<typeof listOpenFindings> {
    return roots.flatMap(listOpenFindings).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
