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
import { sshHostName } from './ssh-host.js';

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
    /** This profile's own Codex home (its login, config.toml, AGENTS.md): the codex judge runs with it as CODEX_HOME. */
    codexHome?: string;
    /**
     * The cursor judge may run under this profile although it reads the person's own Cursor rules, MCP servers and
     * settings: cursor-agent has no switch that gives a profile its own (review/reviewer/judge-isolation.ts).
     */
    cursorShared?: boolean;
}

const TEAM_ENV = ['RIGOUR_ORGANIZATION_ID', 'RIGOUR_TEAM_ID', 'RIGOUR_ACTOR_ID', 'RIGOUR_TEAM_REPOSITORIES', 'RIGOUR_TEAM_DATABASE_URL', 'RIGOUR_TEAM_DATABASE_URL_COMMAND', 'RIGOUR_TEAM_SEMANTIC', 'RIGOUR_TEAM_SYNC_PERSONAL'];

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
    return profileMatch(cwd, profiles)?.profile;
}

/**
 * The profile for `cwd` and the pattern that chose it: the most specific matching pattern wins, whatever the order of
 * the list, so a catch-all (`~/work`, `github.com/acme/*`) never takes a repository a narrower profile names. Specific
 * is how close the pattern is to the repository: an exact remote, or the repository's own folder, is 0; each owner or
 * folder level above it adds one; a folder inside the repository is closer still. On a tie, the earlier profile.
 */
export function profileMatch(cwd: string, profiles: RigourProfile[] = readProfiles()): { profile: RigourProfile; pattern: string } | undefined {
    if (profiles.length === 0) return undefined;
    const where = real(cwd);
    const remote = resolvedRemote(originRemote(cwd), profiles);
    const top = depth(repositoryTop(cwd) ?? where);
    let best: { profile: RigourProfile; pattern: string; distance: number } | undefined;
    for (const profile of profiles) {
        for (const entry of profile.match) {
            let distance: number;
            if (isRemotePattern(entry)) {
                if (!remote || !remoteMatches(remote, entry)) continue;
                const want = hostPath(entry);
                distance = depth(remote) - depth(want.endsWith('/*') ? want.slice(0, -2) : want);
            } else {
                const target = real(expandHome(entry));
                if (!isInside(where, target)) continue;
                distance = top - depth(target);
            }
            if (!best || distance < best.distance) best = { profile, pattern: entry, distance };
        }
    }
    return best && { profile: best.profile, pattern: best.pattern };
}

/**
 * Apply the profile for `cwd` to this process's environment; returns it, or undefined when none matches.
 * A RIGOUR_HOME you set yourself (not one a profile set: RIGOUR_PROFILE is unset) is a home you chose, so
 * no profile replaces it or brings its team: an isolated run stays isolated.
 */
export function applyProfile(cwd: string, profiles?: RigourProfile[]): RigourProfile | undefined {
    if (process.env.RIGOUR_HOME && !process.env.RIGOUR_PROFILE) return undefined;
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

/**
 * The profile this process applied at start (RIGOUR_PROFILE), or undefined when none did. A profile named there but
 * gone from the list is still a profile, with nothing of its own: never read as "no profile".
 */
export function appliedProfile(profiles: RigourProfile[] = readProfiles()): RigourProfile | undefined {
    const name = process.env.RIGOUR_PROFILE;
    if (!name) return undefined;
    return profiles.find(profile => profile.name === name) ?? { name, match: [] };
}

/**
 * This process's environment for a child that must keep its Rigour home wherever it starts: the home made explicit,
 * with no RIGOUR_PROFILE, which is a home chosen for the run that no profile replaces (applyProfile). For a child
 * started in a folder another profile matches, such as doctor's scratch clone in the temp folder: without this it
 * would apply that profile, with its home and team.
 */
export function pinnedHomeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const { RIGOUR_PROFILE: _applied, ...rest } = env;
    return { ...rest, RIGOUR_HOME: env.RIGOUR_HOME || os.homedir() };
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

/**
 * The origin as profiles compare it: a host no profile's remote pattern names may be an SSH alias
 * (`git@work-github:acme/api`), compared as the host it names in the ssh config (ssh-host.ts).
 */
function resolvedRemote(remote: string | undefined, profiles: RigourProfile[]): string | undefined {
    if (!remote) return undefined;
    const [host, ...rest] = remote.split('/');
    const named = new Set(profiles.flatMap(profile => profile.match.filter(isRemotePattern).map(entry => hostPath(entry).split('/')[0])));
    return named.has(host) ? remote : [sshHostName(host) ?? host, ...rest].join('/');
}

function depth(location: string): number {
    return location.split(/[\\/]+/).filter(Boolean).length;
}

function repositoryTop(cwd: string): string | undefined {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    return result.status === 0 ? real(result.stdout.trim()) : undefined;
}

function originRemote(cwd: string): string | undefined {
    const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() ? hostPath(result.stdout) : undefined;
}

/** A path with a leading `~` made absolute. */
export function expandHome(entry: string): string {
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
