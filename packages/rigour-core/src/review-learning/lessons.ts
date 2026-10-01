/**
 * Review lessons: what a team's acted-on review comments taught, ready to
 * hand to the next agent before it opens a PR.
 *
 * A lesson starts as a candidate with its evidence (PR, comment, author). It
 * becomes verified only when the same lesson was acted on in two or more PRs,
 * or a person promotes it. Lessons stay in the repository's .rigour/ folder
 * (ignored by git) and are sent nowhere except to the user's own model.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Git, ReviewComment } from './acted-on.js';

const STORE = path.join('.rigour', 'review-lessons.json');
const MAX_TEXT = 220;
const MAX_SYMBOLS = 8;
const VERIFY_AT_PRS = 2;
const NOT_SYMBOLS = new Set(['this', 'that', 'with', 'from', 'return', 'const', 'await', 'async', 'function', 'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean', 'export', 'import', 'type', 'interface', 'else', 'when', 'then', 'should', 'line', 'lines']);

export interface ReviewLesson {
    id: string;
    text: string;
    file: string;
    symbols: string[];
    state: 'candidate' | 'verified';
    evidence: Array<{ pr: number; comment: string; author: string }>;
    createdAt: string;
    updatedAt: string;
}

/** The point of a review comment: its bold title, else its first sentence, without tool output or markup. */
export function lessonText(body: string): string {
    const cleaned = body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<details>[\s\S]*?<\/details>/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .split('\n')
        .filter(line => !/^\s*(_[^_]+_\s*\|?\s*)+$/.test(line) && !/^\s*[🏁💡🧩🔇🧰📝⚠️🛠️]/u.test(line))
        .join('\n');
    const bold = /\*\*(.+?)\*\*/.exec(cleaned)?.[1]?.trim();
    const text = bold || cleaned.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] || '';
    return text.replace(/[*_]/g, '').slice(0, MAX_TEXT).trim();
}

/** Identifiers a lesson is about: those the comment names, then those on the lines it pointed at. */
export function lessonSymbols(body: string, codeLines: string[]): string[] {
    const named = [...body.matchAll(/`([A-Za-z_$][\w$.]*)`/g)].map(m => m[1].split('.').pop()!);
    const onLines = codeLines.join('\n').match(/[A-Za-z_$][\w$]{3,}/g) ?? [];
    const symbols: string[] = [];
    for (const symbol of [...named, ...onLines]) {
        if (!NOT_SYMBOLS.has(symbol.toLowerCase()) && !symbols.includes(symbol)) symbols.push(symbol);
        if (symbols.length >= MAX_SYMBOLS) break;
    }
    return symbols;
}

export function lessonFromComment(git: Git, comment: ReviewComment, at = new Date().toISOString()): ReviewLesson | undefined {
    const text = lessonText(comment.body);
    if (text.length < 12) return undefined;
    let codeLines: string[] = [];
    try {
        codeLines = git(['show', `${comment.commit}:${comment.path}`]).split('\n').slice(comment.start - 1, comment.end);
    } catch {
        // The file at that commit is unavailable: the comment's own identifiers still describe it.
    }
    return {
        id: crypto.createHash('sha256').update(`${comment.path}\u0000${normalize(text)}`).digest('hex').slice(0, 12),
        text, file: comment.path, symbols: lessonSymbols(comment.body, codeLines), state: 'candidate',
        evidence: [{ pr: comment.prNumber, comment: comment.id, author: comment.author }], createdAt: at, updatedAt: at,
    };
}

/**
 * Add lessons to the store. The same lesson again (same text, or the same
 * file with two shared symbols) adds evidence; acted on in enough PRs, it is
 * verified.
 */
export function mergeLessons(existing: ReviewLesson[], incoming: ReviewLesson[]): { lessons: ReviewLesson[]; added: number; verified: number } {
    const lessons = existing.map(l => ({ ...l, evidence: [...l.evidence] }));
    let added = 0;
    for (const lesson of incoming) {
        const same = lessons.find(l => l.id === lesson.id || (l.file === lesson.file && shared(l.symbols, lesson.symbols) >= 2));
        if (!same) {
            lessons.push(lesson);
            added++;
            continue;
        }
        for (const e of lesson.evidence) if (!same.evidence.some(x => x.comment === e.comment)) same.evidence.push(e);
        same.updatedAt = lesson.updatedAt;
    }
    let verified = 0;
    for (const lesson of lessons) {
        if (lesson.state === 'candidate' && new Set(lesson.evidence.map(e => e.pr)).size >= VERIFY_AT_PRS) {
            lesson.state = 'verified';
            verified++;
        }
    }
    return { lessons, added, verified };
}

export interface ChangeShape {
    files: string[];
    /** Identifiers in the changed code. */
    symbols: Set<string>;
}

/** Lessons that apply to a change, best first: same file, then shared symbols, then same directory. */
export function matchLessons(lessons: ReviewLesson[], change: ChangeShape, options: { includeCandidates?: boolean; limit?: number } = {}): ReviewLesson[] {
    const dirs = new Set(change.files.map(f => path.posix.dirname(f)));
    const scored = lessons
        .filter(l => options.includeCandidates || l.state === 'verified')
        .map(l => ({
            lesson: l,
            score: (change.files.includes(l.file) ? 3 : 0) + (dirs.has(path.posix.dirname(l.file)) ? 1 : 0)
                + 2 * l.symbols.filter(s => change.symbols.has(s)).length,
        }))
        .filter(s => s.score >= 3)
        .sort((a, b) => b.score - a.score || b.lesson.evidence.length - a.lesson.evidence.length);
    return scored.slice(0, options.limit ?? 5).map(s => s.lesson);
}

/** RIGOUR_REVIEW_LESSONS points at a lessons file outside the clone (CI, or a team's shared copy). */
export function lessonsPath(cwd: string): string {
    return process.env.RIGOUR_REVIEW_LESSONS?.trim() || path.join(cwd, STORE);
}

export function readLessons(cwd: string): ReviewLesson[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(lessonsPath(cwd), 'utf8'));
        return Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    } catch {
        return [];
    }
}

export function writeLessons(cwd: string, lessons: ReviewLesson[]): void {
    const file = lessonsPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, lessons }, null, 2) + '\n');
}

export function promoteLesson(cwd: string, id: string): ReviewLesson | undefined {
    const lessons = readLessons(cwd);
    const lesson = lessons.find(l => l.id === id);
    if (!lesson) return undefined;
    lesson.state = 'verified';
    lesson.updatedAt = new Date().toISOString();
    writeLessons(cwd, lessons);
    return lesson;
}

function normalize(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shared(a: string[], b: string[]): number {
    return a.filter(s => b.includes(s)).length;
}
