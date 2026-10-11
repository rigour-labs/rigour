/**
 * The files a shell command wrote, so the edit check sees writes an agent makes through its shell (a heredoc, a
 * redirect, `sed -i`, `gofmt -w`) as it sees an Edit. Found without reading the command: the hook before the call
 * records when it started, and the hook after it asks git which files are changed or new and were written since then.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { repoStateDir } from '@rigour-labs/core';

/** A file's mtime and the call's start come from two clocks a few milliseconds apart: this much earlier still counts. */
const CLOCK_SLACK_MS = 50;

/** The call's id in the hook payload: Claude Code's tool_use_id, else the session's. */
export function toolCallId(payload: { tool_use_id?: unknown; session_id?: unknown; conversation_id?: unknown }): string | undefined {
    const id = payload.tool_use_id ?? payload.session_id ?? payload.conversation_id;
    return typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id) ? id : undefined;
}

function startFile(repo: string, id: string): string {
    return path.join(repoStateDir(repo), 'tool-calls', id);
}

/** Before the call: when it started. */
export function recordToolStart(repo: string, id: string, now = Date.now()): void {
    const file = startFile(repo, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(now));
}

/**
 * After the call: the files it wrote (absolute paths), changed or new in the working tree and written since it started.
 * Undefined when no start was recorded for it (the hook before the call did not run). The record is used once.
 */
export function filesWrittenSince(repo: string, id: string): string[] | undefined {
    const file = startFile(repo, id);
    let start: number;
    try {
        start = Number(fs.readFileSync(file, 'utf8'));
        fs.rmSync(file, { force: true });
    } catch {
        return undefined;
    }
    const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (status.status !== 0) return [];
    const written: string[] = [];
    const entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const code = entry.slice(0, 2);
        if (code[0] === 'R' || code[0] === 'C') i++; // a rename's old path follows; the entry holds the new one
        if (code.includes('D')) continue;
        const full = path.join(repo, entry.slice(3));
        try {
            const stat = fs.statSync(full);
            if (stat.isFile() && stat.mtimeMs >= start - CLOCK_SLACK_MS) written.push(full);
        } catch {
            // gone since git listed it
        }
    }
    return written;
}
