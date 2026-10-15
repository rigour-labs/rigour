/**
 * What may leave this machine for the configured team.
 *
 * One machine often works in repositories of more than one organization (a consultant, an
 * employee with side projects), and the local outbox holds lessons from all of them. Only lessons
 * from the team's own repositories are sent; personal lessons stay on the machine unless the team
 * opts in. Checked when a queued item is about to be sent, so items queued by older versions are
 * held to the same rule.
 */
import { sshHostName } from '../utils/ssh-host.js';

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

/**
 * The command that adds a repository to the team's list, or null when it is listed: the team's patterns with the one
 * that matches it, written as it is compared (an SSH alias resolved to its host).
 */
export function addToTeamList(canonicalUri: string, scope: TeamScope): string | null {
    const { allowed, compared } = teamRepositoryMatch(canonicalUri, scope);
    if (allowed) return null;
    const list = [...(scope.repositories ?? []).map(pattern => pattern.trim()).filter(Boolean), compared].join(',');
    // The environment's list wins over the configured one, so that is the one to change.
    return process.env.RIGOUR_TEAM_REPOSITORIES?.trim()
        ? `set RIGOUR_TEAM_REPOSITORIES='${list}'`
        : `rigour team configure … --repositories '${list}'`;
}

/**
 * Why a queued lesson is not sent now, or null to send it. A lesson from a repository the team does not list yet is
 * `held`: it stays queued and goes with the first sync after the repository is added. A personal lesson, or one whose
 * repository this machine does not know or has no origin remote, stays on this machine.
 */
export function withheldReason(visibility: string, canonicalUri: string | undefined, scope: TeamScope): { reason: string; held: boolean } | null {
    if (visibility === 'personal' && !scope.syncPersonal) return { reason: 'personal lesson', held: false };
    if (!canonicalUri) return { reason: 'repository unknown on this machine', held: false };
    // Recorded by its local path: no pattern can name it, so holding it would keep it queued for ever.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(canonicalUri)) return { reason: 'no origin remote (recorded by its local path)', held: false };
    if (!repositoryAllowed(canonicalUri, scope)) return { reason: notTheTeamsRepository(canonicalUri, scope), held: true };
    return null;
}
