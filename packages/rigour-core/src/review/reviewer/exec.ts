/** How the reviewer runs commands (git, gh, the agent CLIs); tests replace it. */
import { execa } from 'execa';

/** `env` adds variables to the inherited environment; `unset` removes inherited ones the command must not see. */
export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: Record<string, string>; unset?: string[] }) =>
    Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = async (command, args, options) => {
    // stdin is /dev/null, not an empty pipe: an agent CLI that reads stdin sees its end at once, and a command that exits
    // before an empty write lands (git rev-parse) cannot fail the run with EPIPE, as it did on Linux.
    const result = await execa(command, args, { cwd: options.cwd, reject: false, timeout: options.timeoutMs, stdin: 'ignore', ...childEnv(options), maxBuffer: 64 * 1024 * 1024 });
    const stderr = String(result.stderr ?? '');
    // A command that could not start, timed out or was killed writes nothing itself: say which, never an empty failure.
    return { exitCode: result.exitCode ?? 1, stdout: String(result.stdout ?? ''), stderr: stderr || (result.failed && 'shortMessage' in result ? String(result.shortMessage) : '') };
};

/** The environment a command runs with: the inherited one plus `env`, minus `unset` (then nothing is inherited implicitly). */
function childEnv(options: { env?: Record<string, string>; unset?: string[] }): { env?: Record<string, string | undefined>; extendEnv?: boolean } {
    if (!options.unset?.length) return options.env ? { env: { ...process.env, ...options.env } } : {};
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    for (const name of options.unset) delete env[name];
    return { env, extendEnv: false };
}

/** Called while the reviewer works, so a slow run and a stuck one look different. */
export type Progress = (message: string) => void;

export const GH_TIMEOUT_MS = 60_000;

/** The named GitHub account's token for `gh`, when the person keeps several; otherwise gh's own. */
export async function githubEnv(cwd: string, account: string | undefined, exec: Exec): Promise<Record<string, string> | undefined> {
    if (!account || process.env.GH_TOKEN) return undefined;
    const token = await exec('gh', ['auth', 'token', '--user', account], { cwd, timeoutMs: GH_TIMEOUT_MS });
    return token.exitCode === 0 && token.stdout.trim() ? { GH_TOKEN: token.stdout.trim() } : undefined;
}

/**
 * The token to read GitHub with: an explicit one first (GH_TOKEN, GITHUB_TOKEN: CI, or a person's
 * own choice), then the named account's (review.github_account / RIGOUR_GITHUB_ACCOUNT), and the
 * gh CLI's active account only when no account is named, so a machine signed in to several
 * accounts never reads as the wrong one.
 */
export async function githubToken(cwd: string, account: string | undefined, exec: Exec): Promise<string> {
    const explicit = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
    if (explicit) return explicit;
    const named = account?.trim();
    const read = await exec('gh', named ? ['auth', 'token', '--user', named] : ['auth', 'token'], { cwd, timeoutMs: GH_TIMEOUT_MS });
    if (read.exitCode === 0 && read.stdout.trim()) return read.stdout.trim();
    throw new Error(named
        ? `GitHub account ${named} is named for reading, but \`gh auth token --user ${named}\` gave no token: sign in to it with \`gh auth login\`, or set GITHUB_TOKEN.`
        : 'Set GITHUB_TOKEN or sign in with `gh auth login` (read access to the repository is enough).');
}

/** `gh --paginate` prints one JSON array per page. */
export function parseJsonArrays(text: string): any[] {
    try {
        return JSON.parse(`[${text.trim().replace(/\]\s*\[/g, '],[')}]`).flat();
    } catch {
        return [];
    }
}
