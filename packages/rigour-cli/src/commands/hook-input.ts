/**
 * What every agent hook reads first: the payload on stdin, and the repository it runs for. `--if-enabled` (the machine
 * hooks of a personal install) answers here, in the CLI, what a `sh -c` guard used to answer in the shell: a guard only
 * a POSIX shell could run, so on Windows without Git Bash (Claude Code then runs hooks in PowerShell) every hook failed.
 */
import { enabledHere } from './personal.js';

let stdin: { from: NodeJS.ReadStream; text: Promise<string> } | undefined;

/** The hook payload on stdin, read once per stream: `--if-enabled` reads it to find the repository, then the command. */
export function hookStdin(): Promise<string> {
    if (stdin?.from === process.stdin) return stdin.text;
    stdin = { from: process.stdin, text: (async () => {
        if (process.stdin.isTTY) return '';
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString('utf8');
    })() };
    return stdin.text;
}

/** The repository a hook runs for: the agent's project directory, else the payload's cwd, else where the hook started. */
function hookProjectDir(payload: string, env: NodeJS.ProcessEnv = process.env, fallback = process.cwd()): string {
    if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
    try {
        const cwd = JSON.parse(payload || '{}')?.cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
    } catch {
        // not JSON: no cwd in it
    }
    return fallback;
}

/**
 * `--if-enabled`: run the hook only in a repository `rigour setup` switched on, from that repository's directory.
 * Elsewhere it exits 0 and writes nothing, since an agent may read any output as the hook's answer.
 */
export async function runOnlyIfEnabled(): Promise<void> {
    const dir = hookProjectDir(await hookStdin());
    if (!enabledHere(dir)) process.exit(0);
    try {
        process.chdir(dir);
    } catch {
        process.exit(0); // the directory went away: nothing to check
    }
}
