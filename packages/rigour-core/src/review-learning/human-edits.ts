/**
 * A person editing what an agent wrote is the strongest lesson there is: they corrected the work
 * toward what the team wants. The after-edit hook records each file as the agent left it
 * (recordAgentWrites); at the stop and the push, a recorded file that now reads differently was
 * changed by someone else (captureHumanEdits), and that change becomes a candidate lesson with
 * correction evidence. A change that came from git (a checkout, a pull) or only moved whitespace
 * is not a correction. Each edit is taken once. Everything stays in the repository's .rigour/.
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { compactDiff } from '../review/stories.js';
import { mergeLessons, readLessons, writeLessons, type ReviewLesson } from './lessons.js';

const DIR = path.join('.rigour', 'agent-writes');
const MAX_FILE_BYTES = 200_000;
/** Lines of the change kept as the lesson's words. */
const MAX_DIFF_LINES = 12;

interface AgentWrite { file: string; content: string; head?: string; at: string }

const recordPath = (cwd: string, file: string) => path.join(cwd, DIR, `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 16)}.json`);
const squash = (text: string) => text.replace(/\s+/g, '');

function headOf(cwd: string): string | undefined {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return undefined;
    }
}

function atHead(cwd: string, file: string): string | undefined {
    try {
        return execFileSync('git', ['show', `HEAD:${file}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * MAX_FILE_BYTES });
    } catch {
        return undefined;
    }
}

/** Each file as the agent just left it (repository-relative paths). */
export function recordAgentWrites(cwd: string, files: string[]): void {
    const head = headOf(cwd);
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(cwd, file), 'utf8');
            if (content.length > MAX_FILE_BYTES) continue;
            fs.mkdirSync(path.join(cwd, DIR), { recursive: true });
            fs.writeFileSync(recordPath(cwd, file), JSON.stringify({ file, content, ...(head ? { head } : {}), at: new Date().toISOString() } satisfies AgentWrite));
        } catch {
            // a file the agent deleted or cannot be read: nothing to compare later
        }
    }
}

/**
 * The files a person changed since the agent last wrote them, stored as candidate lessons with correction
 * evidence (the rule writer turns each into the rule behind it, or finds none). Returns how many were taken.
 */
export function captureHumanEdits(cwd: string, by = 'a person'): number {
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(path.join(cwd, DIR));
    } catch {
        return 0;
    }
    const at = new Date().toISOString();
    const lessons: ReviewLesson[] = [];
    const head = headOf(cwd);
    for (const entry of entries) {
        const record = path.join(cwd, DIR, entry);
        let write: AgentWrite;
        let now: string;
        try {
            write = JSON.parse(fs.readFileSync(record, 'utf8'));
            now = fs.readFileSync(path.join(cwd, write.file), 'utf8');
        } catch {
            fs.rmSync(record, { force: true });
            continue;
        }
        if (now === write.content) continue;
        fs.rmSync(record, { force: true }); // taken once, whatever it was
        if (squash(now) === squash(write.content)) continue; // whitespace only
        if (head && head !== write.head && atHead(cwd, write.file) === now) continue; // came from git: a checkout, a pull, a merge
        const diff = compactDiff(write.content, now).slice(0, MAX_DIFF_LINES).join('\n');
        const text = `In ${write.file}, a person changed what the agent wrote:\n${diff}`;
        lessons.push({
            id: crypto.createHash('sha256').update(`${write.file}\u0000${diff}`).digest('hex').slice(0, 12),
            text, file: write.file, symbols: [], state: 'candidate',
            evidence: [{ kind: 'correction', pr: 0, comment: `edit-${crypto.createHash('sha256').update(`${write.file}${write.at}`).digest('hex').slice(0, 12)}`, author: by, text, detail: `edited after the agent's write of ${write.at}`, at }],
            createdAt: at, updatedAt: at,
        });
    }
    if (lessons.length) writeLessons(cwd, mergeLessons(readLessons(cwd), lessons).lessons);
    return lessons.length;
}
