/**
 * How a judge that runs code is confined (review.reviewer.run_code), each claim verified with a real run of the CLI in a
 * scratch repository outside /tmp/claude-<uid>, on macOS (docs/REVIEWER.md lists the evidence). Elsewhere it is
 * unverified, so no judge runs code there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeTmp } from './cli-leftovers.js';

/** Where the sandboxes were verified: run_code is refused on any other platform. */
export function runCodePlatformRefusal(platform: NodeJS.Platform = process.platform): string | undefined {
    return platform === 'darwin' ? undefined : `its sandbox is verified on macOS only, and this is ${platform}`;
}

/**
 * codex-cli 0.160.1, verified: workspace-write with network off and the temporary directories left out writes only its
 * working directory. `--ignore-user-config` drops the person's config.toml, and with it every project trust entry, so a
 * `.codex/config.toml` the reviewed commit carries is never loaded (a committed one that widened writable_roots, turned
 * the network on and set variables was ignored); `--ignore-rules` drops execpolicy rules; the keys a project config
 * could set are pinned besides, and its shell is not a login shell. Its sandbox cannot deny reads: home files stay
 * readable, as in read-only mode, while the keychain and git's credential helper stayed closed (no password returned).
 */
export const CODEX_RUN_CODE = [
    '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'approval_policy=never',
    // A login shell sources the person's profile, which can export the very secrets Rigour removed (a real run did).
    '-c', 'allow_login_shell=false',
];

/** What codex may write besides its working directory: only the judge's own temporary directory, never a root the repo names. */
export function codexWritable(place: SandboxPlace | undefined): string[] {
    return ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(place?.tmp ? [real(place.tmp)] : [])}`];
}

/**
 * What a judge that runs code may read back under the home directory, which its sandbox otherwise denies whole: the
 * toolchains a scratch test runs with (version managers, package caches, user-installed binaries), never a folder that
 * holds a login or a person's settings.
 */
const TOOLCHAINS = [
    '.nvm', '.volta', '.asdf', '.pyenv', '.rbenv', '.rustup', '.cargo/bin', 'go/bin', 'go/pkg/mod', '.bun/bin', '.deno/bin',
    '.local/bin', 'Library/pnpm', '.npm/_cacache', '.npm/_npx',
];

/** A path as the sandbox matches it: the real one, when it exists. */
const real = (p: string) => {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
};

function claudeTmpEntries(env: NodeJS.ProcessEnv): string[] {
    const dir = claudeTmp(env);
    try {
        return dir ? fs.readdirSync(dir).map(name => path.join(dir, name)) : [];
    } catch {
        return [];
    }
}

/** Where a judge that runs code works: its copy, the person's repository it was made from, and the review's input folder. */
export interface SandboxPlace { copy: string; repo: string; work?: string; tmp?: string }

/**
 * Claude Code 2.1.285's sandbox for a judge that runs code, verified with real runs (docs/REVIEWER.md): commands run
 * sandboxed without a prompt, the dangerouslyDisableSandbox escape is ignored, a sandbox that cannot start fails the
 * run, no host is reachable. Reads: the whole home directory and the temporary directory are denied (logins, keys,
 * history, browser profiles, app settings, other processes' temporary files) and only the copy, this review's input
 * folder, the repository's installed dependencies and the toolchains above are read back; the repository's own .git is denied wherever it lives. Writes: only the copy, never its .git
 * (whose objects are the person's, hardlinked) nor what other sessions keep in Claude Code's temporary folder.
 */
export function claudeSandbox(place: SandboxPlace, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    const allowRead = [place.copy, ...(place.tmp ? [real(place.tmp)] : []), ...(place.work ? [real(place.work)] : []), real(path.join(place.repo, 'node_modules')), ...TOOLCHAINS.map(p => real(path.join(home, p)))].filter(p => fs.existsSync(p));
    return {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
        network: { allowedDomains: [], strictAllowlist: true },
        filesystem: {
            // The temporary directories hold other processes' files (other reviews' inputs and judges' temporary bases,
            // Claude Code's shared /tmp/claude-<uid>, other tools' state): denied too; the judge's own base is read back.
            denyRead: [real(home), real(os.tmpdir()), real('/tmp'), real(path.join(place.repo, '.git'))],
            allowRead: [...new Set(allowRead)],
            denyWrite: [...claudeTmpEntries(env), path.join(place.copy, '.git')],
        },
    };
}
