/**
 * Profiles: one machine, many organizations.
 *
 * A person who works for more than one organization needs Rigour's memory, lessons and team
 * database kept apart per organization, chosen by the repository, not by whichever server or shell
 * happened to start. `~/.rigour/profiles.json` (or RIGOUR_PROFILES) lists profiles; the first whose
 * `match` fits the repository (a path prefix, or an origin remote like `github.com/acme/*`) is
 * applied before the rest of Rigour loads: its home becomes RIGOUR_HOME, and team settings come
 * from the profile alone (any inherited from the shell are cleared, so another organization's team
 * can never apply). A long-running server records the profile it started with, and refuses a call
 * for a repository of another profile instead of answering it with the wrong home.
 *
 * Dependency-free on purpose: it runs before the rest of the package is imported.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RigourProfile {
    name: string;
    /** Path prefixes (`~/work/acme`) or origin remotes (`github.com/acme/*`). */
    match: string[];
    /** The home whose `.rigour/` holds this profile's state. */
    home?: string;
    team?: {
        organization: string;
        team: string;
        actor: string;
        /** The team's repositories; lessons from any other repository stay local. */
        repositories?: string[];
        /** A command that prints the team database URL (from a keychain, a vault); never stored in the file. */
        databaseUrlCommand?: string;
    };
    /** The GitHub account whose token fetches pull request reviews. */
    githubAccount?: string;
}

const TEAM_ENV = ['RIGOUR_ORGANIZATION_ID', 'RIGOUR_TEAM_ID', 'RIGOUR_ACTOR_ID', 'RIGOUR_TEAM_REPOSITORIES', 'RIGOUR_TEAM_DATABASE_URL', 'RIGOUR_TEAM_DATABASE_URL_COMMAND', 'RIGOUR_TEAM_SEMANTIC'];

/** Where profiles are listed: always the person's real home, never a profile's. */
export function profilesPath(): string {
    return process.env.RIGOUR_PROFILES || path.join(os.homedir(), '.rigour', 'profiles.json');
}

export function readProfiles(): RigourProfile[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(profilesPath(), 'utf8'));
        return Array.isArray(parsed?.profiles) ? parsed.profiles.filter((p: any) => p && typeof p.name === 'string' && Array.isArray(p.match)) : [];
    } catch {
        return [];
    }
}

export function writeProfiles(profiles: RigourProfile[]): void {
    fs.mkdirSync(path.dirname(profilesPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(profilesPath(), JSON.stringify({ profiles }, null, 2) + '\n', { mode: 0o600 });
}

/** The first profile whose match fits `cwd`, by path or by origin remote. */
export function profileFor(cwd: string, profiles: RigourProfile[] = readProfiles()): RigourProfile | undefined {
    if (profiles.length === 0) return undefined;
    const where = real(cwd);
    const remote = originRemote(cwd);
    return profiles.find(profile => profile.match.some(entry => isRemotePattern(entry)
        ? !!remote && remoteMatches(remote, entry)
        : isInside(where, real(expandHome(entry)))));
}

/** Apply the profile for `cwd` to this process's environment; returns it, or undefined when none matches. */
export function applyProfile(cwd: string, profiles?: RigourProfile[]): RigourProfile | undefined {
    const profile = profileFor(cwd, profiles);
    if (!profile) return undefined;
    process.env.RIGOUR_PROFILE = profile.name;
    if (profile.home) process.env.RIGOUR_HOME = expandHome(profile.home);
    for (const name of TEAM_ENV) delete process.env[name];
    if (profile.team) {
        process.env.RIGOUR_ORGANIZATION_ID = profile.team.organization;
        process.env.RIGOUR_TEAM_ID = profile.team.team;
        process.env.RIGOUR_ACTOR_ID = profile.team.actor;
        if (profile.team.repositories?.length) process.env.RIGOUR_TEAM_REPOSITORIES = profile.team.repositories.join(',');
        if (profile.team.databaseUrlCommand) process.env.RIGOUR_TEAM_DATABASE_URL_COMMAND = profile.team.databaseUrlCommand;
    }
    if (profile.githubAccount) process.env.RIGOUR_GITHUB_ACCOUNT = profile.githubAccount;
    return profile;
}

/** Why this process must not act for `cwd` (it belongs to another profile than the one applied at start), or null. */
export function profileMismatch(cwd: string, profiles?: RigourProfile[]): string | null {
    const belongs = profileFor(cwd, profiles)?.name;
    const running = process.env.RIGOUR_PROFILE;
    if (belongs === running) return null;
    return `This repository belongs to the Rigour profile "${belongs ?? '(none)'}", but this server started as "${running ?? '(none)'}". `
        + 'Refusing so one profile\'s memory and team never reach another: start Rigour from this repository (or with RIGOUR_CWD set to it).';
}

function isRemotePattern(entry: string): boolean {
    return /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(entry.replace(/^[a-z]+:\/\//i, ''));
}

function remoteMatches(remote: string, pattern: string): boolean {
    const want = hostPath(pattern);
    return want.endsWith('/*') ? remote.startsWith(want.slice(0, -1)) : remote === want;
}

/** `git@github.com:acme/api.git` and `https://github.com/acme/api` both become `github.com/acme/api`. */
export function hostPath(remote: string): string {
    return remote.trim().toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/^[^@/]+@/, '')
        .replace(/^([^/:]+):(?!\d)/, '$1/')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '');
}

function originRemote(cwd: string): string | undefined {
    const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() ? hostPath(result.stdout) : undefined;
}

function expandHome(entry: string): string {
    return entry.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** The real path; for a path that does not exist yet, its nearest existing parent's real path plus the rest. */
function real(dir: string): string {
    const absolute = path.resolve(dir);
    try {
        return fs.realpathSync.native(absolute);
    } catch {
        const parent = path.dirname(absolute);
        return parent === absolute ? absolute : path.join(real(parent), path.basename(absolute));
    }
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
