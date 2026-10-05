/**
 * What may leave this machine for the configured team.
 *
 * One machine often works in repositories of more than one organization (a consultant, an
 * employee with side projects), and the local outbox holds lessons from all of them. Only lessons
 * from the team's own repositories are sent; personal lessons stay on the machine unless the team
 * opts in. Checked when a queued item is about to be sent, so items queued by older versions are
 * held to the same rule.
 */

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
    const repo = hostPath(canonicalUri);
    // No list, nothing leaves: a team names its repositories before any lesson is sent.
    return (scope.repositories ?? []).some(pattern => {
        const want = hostPath(pattern.trim());
        return want.endsWith('/*') ? repo.startsWith(want.slice(0, -1)) : repo === want;
    });
}

/** Why a queued lesson must stay on this machine, or null to send it. */
export function withheldReason(visibility: string, canonicalUri: string | undefined, scope: TeamScope): string | null {
    if (visibility === 'personal' && !scope.syncPersonal) return 'personal lesson';
    if (!canonicalUri) return 'repository unknown on this machine';
    if (!repositoryAllowed(canonicalUri, scope)) return `repository ${hostPath(canonicalUri)} is not one of the team's repositories`;
    return null;
}
