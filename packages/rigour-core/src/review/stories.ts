/**
 * What Rigour stopped, as people read it: one entry per problem an agent fixed after Rigour
 * reported it, with the stage that caught it and the code change that fixed it.
 *
 * agent-fixes.ts keeps the before and after only until `rigour learn` turns them into rules;
 * this log keeps a small, permanent summary for Studio. It never holds whole files: only the
 * changed lines with a little context, capped.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Where a problem was caught: while the agent wrote, when it asked to review, when it tried to finish, at the PR. */
export type CatchStage = 'edit' | 'review' | 'stop' | 'pr';

export interface Story {
    id: string;
    at: string;
    stage: CatchStage;
    file: string;
    rule: string;
    title: string;
    details?: string;
    /** Changed lines with context, each prefixed ' ', '-' or '+'. */
    diff: string[];
}

export const STORIES_FILE = path.join('.rigour', 'stories.jsonl');
/** Kept on disk; older entries are dropped when the log is rewritten. */
const MAX_STORIES = 500;
const CONTEXT_LINES = 2;
const MAX_DIFF_LINES = 40;
const MAX_LINE_CHARS = 200;

export function appendStory(cwd: string, story: Omit<Story, 'id'>): void {
    const entry: Story = { id: crypto.createHash('sha256').update(`${story.at}\0${story.file}\0${story.rule}`).digest('hex').slice(0, 16), ...story };
    const file = path.join(cwd, STORIES_FILE);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
        trim(file);
    } catch {
        // Stories are a view; failing to keep one must never break a review or a hook.
    }
}

/** Every story, oldest first; `since` keeps those at or after it. */
export function readStories(cwd: string, since?: Date): Story[] {
    let lines: string[];
    try {
        lines = fs.readFileSync(path.join(cwd, STORIES_FILE), 'utf8').split('\n');
    } catch {
        return [];
    }
    const stories = lines.flatMap(line => {
        try {
            return line.trim() ? [JSON.parse(line) as Story] : [];
        } catch {
            return [];
        }
    });
    return since ? stories.filter(s => Date.parse(s.at) >= since.getTime()) : stories;
}

/**
 * The lines that changed between two versions of a file, with context: the common head and
 * tail are trimmed and what is left between them is shown as removed then added.
 */
export function compactDiff(before: string, after: string): string[] {
    const a = before.split('\n');
    const b = after.split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const clip = (line: string) => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line);
    const lines = [
        ...a.slice(Math.max(0, head - CONTEXT_LINES), head).map(l => ' ' + clip(l)),
        ...a.slice(head, a.length - tail).map(l => '-' + clip(l)),
        ...b.slice(head, b.length - tail).map(l => '+' + clip(l)),
        ...a.slice(a.length - tail, Math.min(a.length, a.length - tail + CONTEXT_LINES)).map(l => ' ' + clip(l)),
    ];
    return lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), ' …'] : lines;
}

function trim(file: string): void {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_STORIES * 1.2) fs.writeFileSync(file, lines.slice(-MAX_STORIES).join('\n') + '\n');
}
