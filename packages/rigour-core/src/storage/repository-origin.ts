/** Where a checkout comes from: its origin remote, read from the git config without running git. */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { sshHostName } from '../utils/ssh-host.js';

/** An origin as https, lowercase, without `.git`: the form before any SSH host alias is resolved. */
function normalizeRemote(remote: string): string {
    return remote.trim()
        .replace(/^git@([^:]+):/, 'https://$1/')
        .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, 'https://$1/')
        .replace(/\.git$/, '').toLowerCase();
}

/** Whether git reaches this origin over SSH, where its host may be an alias in the ssh config. */
function isSshRemote(remote: string): boolean {
    return /^(?:[^@/\s]+@[^:/\s]+:|ssh:\/\/)/.test(remote.trim());
}

/**
 * The same origin with an SSH host alias replaced by the host it names (`git@work-forge:acme/api` → the https form on
 * forge.example.com), so every checkout of one repository has one origin, whichever remote form it uses.
 */
function canonicalRemote(remote: string): string {
    const normalized = normalizeRemote(remote);
    if (!isSshRemote(remote)) return normalized;
    const host = normalized.match(/^https:\/\/([^/]+)\//)?.[1];
    const real = host ? sshHostName(host) : undefined;
    return real ? normalized.replace(`https://${host}/`, `https://${real}/`) : normalized;
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

function originRemote(cwd: string): string | undefined {
    try {
        return readGitConfig(cwd).match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1];
    } catch {
        return undefined;
    }
}

/** The repository's origin remote as Rigour records it (`https://github.com/acme/api`, an SSH alias resolved), or undefined without one. */
function originOfSync(cwd: string): string | undefined {
    const remote = originRemote(cwd);
    return remote ? canonicalRemote(remote) : undefined;
}

/**
 * The id this repository had before Rigour resolved SSH host aliases (7.0.9), when that differs from its id now: the
 * local store re-keys rows filed under it once (lessons.ts registerRepository).
 */
export function legacyRepositoryId(cwd: string): string | undefined {
    const remote = originRemote(cwd);
    if (!remote) return undefined;
    const legacy = createHash('sha256').update(normalizeRemote(remote)).digest('hex');
    return legacy === repositoryIdSync(cwd) ? undefined : legacy;
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
