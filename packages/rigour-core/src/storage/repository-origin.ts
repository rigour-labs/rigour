/** Where a checkout comes from: its origin remote, read from the git config without running git. */
import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

function normalizeRemote(remote: string): string {
    return remote.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').toLowerCase();
}

async function readGitConfig(cwd: string): Promise<string> {
    const dotGit = path.join(cwd, '.git');
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return fs.readFile(path.join(dotGit, 'config'), 'utf8');
    const pointer = await fs.readFile(dotGit, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error('Invalid Git directory pointer.');
    const gitDir = path.resolve(cwd, match[1].trim());
    try {
        return await fs.readFile(path.join(gitDir, 'config'), 'utf8');
    } catch {
        // Linked worktrees usually keep the shared remote configuration here.
        const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
        return fs.readFile(path.resolve(gitDir, commonDir, 'config'), 'utf8');
    }
}

/** The repository's origin remote as Rigour records it (`https://github.com/acme/api`), or undefined without one. */
export async function originOf(cwd: string): Promise<string | undefined> {
    try {
        const remote = (await readGitConfig(cwd)).match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1];
        return remote ? normalizeRemote(remote) : undefined;
    } catch {
        return undefined;
    }
}

/** A repository's stable id: the SHA-256 of its origin remote, or of its path without one. */
export async function getRepositoryId(cwd: string): Promise<string> {
    // Non-git workspaces retain a stable path-derived local identity.
    return createHash('sha256').update((await originOf(cwd)) ?? path.resolve(cwd)).digest('hex');
}
