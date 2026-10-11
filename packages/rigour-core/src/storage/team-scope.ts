/**
 * What may leave this machine for the configured team.
 *
 * One machine often works in repositories of more than one organization (a consultant, an
 * employee with side projects), and the local outbox holds lessons from all of them. Only lessons
 * from the team's own repositories are sent; personal lessons stay on the machine unless the team
 * opts in. Checked when a queued item is about to be sent, so items queued by older versions are
 * held to the same rule.
 */
import { spawnSync } from 'child_process';

export interface TeamScope {
    organizationId: string;
    /** Repository patterns such as `github.com/acme/*` or `gitlab.com/acme/api`; matched against the origin remote. */
    repositories?: string[];
    /** Also send lessons marked personal (default false). */
    syncPersonal?: boolean;
}

/** The origin remote as Rigour records it, without its scheme: `github.com/acme/api`. */
function hostPath(canonicalUri: string): string {
    return canonicalUri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').toLowerCase();
}

/** Whether a repository, by its recorded origin remote, belongs to the team. */
export function repositoryAllowed(canonicalUri: string, scope: TeamScope): boolean {
    return teamRepositoryMatch(canonicalUri, scope).allowed;
}

/**
 * Whether a repository belongs to the team, and the remote it was compared as. A host the team's patterns do not name may
 * be an SSH alias (`git@work-github:acme/api`): it is compared as the host `ssh -G` resolves it to. A pattern with no
 * host (`acme/*`) matches the owner and repository path on any host.
 */
function teamRepositoryMatch(canonicalUri: string, scope: TeamScope): { allowed: boolean; compared: string } {
    const patterns = (scope.repositories ?? []).map(pattern => hostPath(pattern.trim())).filter(Boolean);
    const [host, ...rest] = hostPath(canonicalUri).split('/');
    const known = new Set(patterns.filter(hasHost).map(pattern => pattern.split('/')[0]));
    const resolved = known.has(host) ? host : sshHostName(host) ?? host;
    const compared = [resolved, ...rest].join('/');
    const path = rest.join('/');
    // No list, nothing leaves: a team names its repositories before any lesson is sent.
    const allowed = patterns.some(pattern => matches(hasHost(pattern) ? compared : path, pattern));
    return { allowed, compared };
}

function hasHost(pattern: string): boolean {
    return pattern.split('/')[0].includes('.');
}

function matches(repo: string, want: string): boolean {
    return want.endsWith('/*') ? repo.startsWith(want.slice(0, -1)) : repo === want;
}

/** Why a repository is not shared with the team, naming the remote it was compared as. */
export function notTheTeamsRepository(canonicalUri: string, scope: TeamScope): string {
    const { compared } = teamRepositoryMatch(canonicalUri, scope);
    const as = compared === hostPath(canonicalUri) ? '' : ` (compared as ${compared}, its SSH host resolved)`;
    return `repository ${hostPath(canonicalUri)}${as} is not one of the team's repositories`;
}

const resolvedHosts = new Map<string, string | undefined>();

/**
 * The host an SSH alias names (`HostName` in the ssh config, read by `ssh -G`, which connects to nothing), or undefined
 * when it names no other. RIGOUR_SSH_CONFIG names the config to read; ssh's own by default.
 */
function sshHostName(host: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(host)) return undefined; // nothing ssh could read as an option
    if (resolvedHosts.has(host)) return resolvedHosts.get(host);
    const config = process.env.RIGOUR_SSH_CONFIG;
    const run = spawnSync('ssh', [...(config ? ['-F', config] : []), '-G', host], { encoding: 'utf8', timeout: 2000 });
    const name = run.status === 0 ? run.stdout.match(/^hostname\s+(\S+)$/m)?.[1]?.toLowerCase() : undefined;
    const resolved = name && name !== host ? name : undefined;
    resolvedHosts.set(host, resolved);
    return resolved;
}

/** Why a queued lesson must stay on this machine, or null to send it. */
export function withheldReason(visibility: string, canonicalUri: string | undefined, scope: TeamScope): string | null {
    if (visibility === 'personal' && !scope.syncPersonal) return 'personal lesson';
    if (!canonicalUri) return 'repository unknown on this machine';
    if (!repositoryAllowed(canonicalUri, scope)) return notTheTeamsRepository(canonicalUri, scope);
    return null;
}
