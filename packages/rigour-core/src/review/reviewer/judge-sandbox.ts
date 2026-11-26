/**
 * How a judge that runs code is confined (review.reviewer.run_code), each claim verified with a real run of the CLI in a
 * scratch repository outside /tmp/claude-<uid>, on macOS (docs/REVIEWER.md lists the evidence). Elsewhere it is
 * unverified, so no judge runs code there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Where the sandboxes were verified: run_code is refused on any other platform. */
export function runCodePlatformRefusal(platform: NodeJS.Platform = process.platform): string | undefined {
    return platform === 'darwin' ? undefined : `its sandbox is verified on macOS only, and this is ${platform}`;
}

/**
 * codex-cli 0.160.1, verified: workspace-write with network off and the temporary directories left out writes only its
 * working directory. `--ignore-user-config` drops the person's config.toml, and with it every project trust entry, so a
 * `.codex/config.toml` the reviewed commit carries is never loaded (a committed one that widened writable_roots, turned
 * the network on and set variables was ignored); `--ignore-rules` drops execpolicy rules; the keys a project config
 * could set are pinned besides. Its sandbox cannot deny reads: home files stay readable, as in read-only mode, while
 * the keychain and git's credential helper stayed closed (no password returned).
 */
export const CODEX_RUN_CODE = [
    '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'approval_policy=never',
];

/** Home paths holding credentials: a judge that runs code under Claude Code's sandbox cannot read them. */
const SECRET_HOME_PATHS = [
    '.ssh', '.aws', '.npmrc', '.netrc', '.config/gh', '.docker', '.kube', '.gnupg', 'Library/Keychains', '.git-credentials',
    '.config/git/credentials', '.local/share/keyrings', '.password-store', '.config/gcloud', '.azure', '.pypirc', '.terraform.d',
    '.cargo/credentials.toml', '.gem/credentials', '.claude/.credentials.json', '.claude.json', '.codex/auth.json',
];

/** Claude Code's own temporary folder, `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`: other sessions keep their files there. */
function claudeTmp(env: NodeJS.ProcessEnv): string | undefined {
    try {
        return path.join(fs.realpathSync(env.CLAUDE_CODE_TMPDIR || '/tmp'), `claude-${process.getuid?.() ?? 0}`);
    } catch {
        return undefined;
    }
}

function claudeTmpEntries(env: NodeJS.ProcessEnv): string[] {
    const dir = claudeTmp(env);
    try {
        return dir ? fs.readdirSync(dir).map(name => path.join(dir, name)) : [];
    } catch {
        return [];
    }
}

/**
 * Removes the folder Claude Code made for a run in `copy` in its temporary folder: named after the working directory,
 * every character but a letter or digit a `-`. The copy's path is new for each run, so the name is the run's alone.
 */
export function removeClaudeTmpOf(copy: string, env: NodeJS.ProcessEnv = process.env): void {
    const dir = claudeTmp(env);
    if (dir) fs.rmSync(path.join(dir, copy.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
}

/**
 * Claude Code 2.1.285's sandbox for a judge that runs code, verified: commands run sandboxed without a prompt, the
 * dangerouslyDisableSandbox escape is ignored, a sandbox that cannot start fails the run, no host is reachable, writes
 * outside the working directory are refused, the credential files above and the keychain cannot be read (no password
 * from `git credential fill`, even naming the keychain helper; `security find-internet-password` fails), and what other
 * sessions keep in its temporary folder cannot be written or deleted. It still writes new files of its own there.
 */
export function claudeSandbox(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    return {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
        network: { allowedDomains: [], strictAllowlist: true },
        filesystem: { denyRead: SECRET_HOME_PATHS.map(p => path.join(home, p)), denyWrite: claudeTmpEntries(env) },
    };
}

/**
 * codex-cli 0.160.1 records the directory it runs in as a trusted project in `<CODEX_HOME>/config.toml`, even with
 * `--ignore-user-config` (a real run): the copy's entry is removed, so no review leaves one behind. The copy's path is
 * the run's alone; nothing else in the file changes.
 */
export function removeCodexTrustOf(copy: string, codexHome: string): void {
    const file = path.join(codexHome, 'config.toml');
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
    const lines = text.split('\n');
    const at = lines.indexOf(`[projects.${JSON.stringify(copy)}]`);
    if (at < 0) return;
    let end = at + 1;
    while (end < lines.length && !lines[end].startsWith('[')) end++;
    while (end > at + 1 && lines[end - 1] === '') end--; // the blank line before the next table stays
    const start = at > 0 && lines[at - 1] === '' ? at - 1 : at;
    lines.splice(start, end - start);
    fs.writeFileSync(file, lines.join('\n'));
}
