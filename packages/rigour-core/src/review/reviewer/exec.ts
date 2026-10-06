/** How the reviewer runs commands (git, gh, the agent CLIs); tests replace it. */
import { execa } from 'execa';

export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: Record<string, string> }) =>
    Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = async (command, args, options) => {
    // stdin is /dev/null, not an empty pipe: an agent CLI that reads stdin sees its end at once, and a command that exits
    // before an empty write lands (git rev-parse) cannot fail the run with EPIPE, as it did on Linux.
    const result = await execa(command, args, { cwd: options.cwd, reject: false, timeout: options.timeoutMs, stdin: 'ignore', env: options.env ? { ...process.env, ...options.env } : undefined, maxBuffer: 64 * 1024 * 1024 });
    const stderr = String(result.stderr ?? '');
    // A command that could not start, timed out or was killed writes nothing itself: say which, never an empty failure.
    return { exitCode: result.exitCode ?? 1, stdout: String(result.stdout ?? ''), stderr: stderr || (result.failed && 'shortMessage' in result ? String(result.shortMessage) : '') };
};

/** Called while the reviewer works, so a slow run and a stuck one look different. */
export type Progress = (message: string) => void;

export const GH_TIMEOUT_MS = 60_000;

/** The named GitHub account's token for `gh`, when the person keeps several; otherwise gh's own. */
export async function githubEnv(cwd: string, account: string | undefined, exec: Exec): Promise<Record<string, string> | undefined> {
    if (!account || process.env.GH_TOKEN) return undefined;
    const token = await exec('gh', ['auth', 'token', '--user', account], { cwd, timeoutMs: GH_TIMEOUT_MS });
    return token.exitCode === 0 && token.stdout.trim() ? { GH_TOKEN: token.stdout.trim() } : undefined;
}

/** `gh --paginate` prints one JSON array per page. */
export function parseJsonArrays(text: string): any[] {
    try {
        return JSON.parse(`[${text.trim().replace(/\]\s*\[/g, '],[')}]`).flat();
    } catch {
        return [];
    }
}
