/** Where a checkout comes from: its origin remote, read from the git config without running git. */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { sshHostName } from '../utils/ssh-host.js';

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

function originRemote(cwd: string): string | undefined {
    try {
        return readGitConfig(cwd).match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1]?.trim();
    } catch {
        return undefined;
    }
}

/** The repository's origin remote as Rigour records it (`https://github.com/acme/api`), or undefined without one. */
function originOfSync(cwd: string): string | undefined {
    const remote = originRemote(cwd);
    return remote ? normalizeRemote(remote) : undefined;
}

/**
 * The origin as one form for every way of writing it: https, the host an SSH alias names (`git@work-forge:acme/api`,
 * `work-forge:acme/api`, `ssh://git@work-forge:22/acme/api`), lowercase, without `.git`. Never an id by itself: ids stay
 * as they were recorded (repositoryIdSync); this only finds the other ids one repository has.
 */
function canonicalRemote(remote: string): string | undefined {
    const ssh = remote.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/) ?? remote.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/);
    if (ssh) {
        const host = ssh[1].toLowerCase();
        return `https://${sshHostName(host) ?? host}/${ssh[2]}`.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
    }
    return /^https?:\/\//i.test(remote) ? normalizeRemote(remote).replace(/^http:\/\//, 'https://').replace(/\/+$/, '') : undefined;
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

/**
 * Every id this repository's lessons may be filed under: this checkout's own, and the one an https clone of the same
 * repository has, so a checkout whose origin is an SSH remote or alias lists the candidates an agent saved in an https
 * clone (a cloud reviewer's). Stored ids never change.
 */
export function sameRepositoryIds(cwd: string): string[] {
    const own = repositoryIdSync(cwd);
    const remote = originRemote(cwd);
    const canonical = remote ? canonicalRemote(remote) : undefined;
    const other = canonical ? createHash('sha256').update(canonical).digest('hex') : undefined;
    return other && other !== own ? [own, other] : [own];
}
