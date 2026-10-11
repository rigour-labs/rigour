/** Where a checkout comes from: its origin remote, read from the git config without running git. */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

function normalizeRemote(remote: string): string {
    return remote.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').toLowerCase();
}

function readGitConfig(cwd: string): string {
    const dotGit = path.join(cwd, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return fs.readFileSync(path.join(dotGit, 'config'), 'utf8');
    const pointer = fs.readFileSync(dotGit, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error('Invalid Git directory pointer.');
    const gitDir = path.resolve(cwd, match[1].trim());
    try {
        return fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    } catch {
        // Linked worktrees usually keep the shared remote configuration here.
        const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        return fs.readFileSync(path.resolve(gitDir, commonDir, 'config'), 'utf8');
    }
}

/** The repository's origin remote as Rigour records it (`https://github.com/acme/api`), or undefined without one. */
function originOfSync(cwd: string): string | undefined {
    try {
        const remote = readGitConfig(cwd).match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1];
        return remote ? normalizeRemote(remote) : undefined;
    } catch {
        return undefined;
    }
}

export async function originOf(cwd: string): Promise<string | undefined> {
    return originOfSync(cwd);
}

/** A repository's stable id: the SHA-256 of its origin remote, or of its path without one. */
export function repositoryIdSync(cwd: string): string {
    // Non-git workspaces retain a stable path-derived local identity.
    return createHash('sha256').update(originOfSync(cwd) ?? path.resolve(cwd)).digest('hex');
}

export async function getRepositoryId(cwd: string): Promise<string> {
    return repositoryIdSync(cwd);
}
