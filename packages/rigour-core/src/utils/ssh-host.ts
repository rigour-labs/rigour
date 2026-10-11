/**
 * The host an SSH alias names, for matching an `origin` like `git@work-github:acme/api` against patterns written on the
 * real host: team repositories (storage/team-scope.ts) and profiles (utils/profile.ts).
 */
import { spawnSync } from 'child_process';

const resolvedHosts = new Map<string, string | undefined>();

/**
 * The host an SSH alias names (`HostName` in the ssh config, read by `ssh -G`, which connects to nothing), or undefined
 * when it names no other. RIGOUR_SSH_CONFIG names the config to read; ssh's own by default.
 */
export function sshHostName(host: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(host)) return undefined; // nothing ssh could read as an option
    if (resolvedHosts.has(host)) return resolvedHosts.get(host);
    const config = process.env.RIGOUR_SSH_CONFIG;
    const run = spawnSync('ssh', [...(config ? ['-F', config] : []), '-G', host], { encoding: 'utf8', timeout: 2000 });
    const name = run.status === 0 ? run.stdout.match(/^hostname\s+(\S+)$/m)?.[1]?.toLowerCase() : undefined;
    const resolved = name && name !== host ? name : undefined;
    resolvedHosts.set(host, resolved);
    return resolved;
}
