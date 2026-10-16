/**
 * What the Pull requests page reads, as Rigour wrote it: the task threads in the common git folder, every checkout's
 * outcomes.json and review-lessons.json, and the reviewer's records beside its verdicts. Read only; a file that is
 * missing or does not parse reads as nothing recorded.
 */
import fs from 'fs';
import path from 'path';
import { readLessons, threadsDir, type PrOutcome, type ReviewLesson, type ReviewRecord, type ThreadEvent } from '@rigour-labs/core';

/** Every thread on this machine, one per branch file, each oldest first; lines that do not parse are skipped. */
export function readAllThreads(cwd: string): ThreadEvent[][] {
    const dir = threadsDir(cwd);
    if (!dir) return [];
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
        return [];
    }
    return files.map(file => readEvents(path.join(dir, file))).filter(events => events.length > 0);
}

function readEvents(file: string): ThreadEvent[] {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    return text.split('\n').filter(Boolean).flatMap(line => {
        try {
            const e = JSON.parse(line);
            return e && typeof e.at === 'string' && typeof e.task === 'string' && typeof e.kind === 'string' ? [e as ThreadEvent] : [];
        } catch {
            return [];
        }
    }).sort((a, b) => a.at.localeCompare(b.at));
}

/** Each merged pull request's outcome across the checkouts, by number: a settled record wins, else the latest read. */
export function outcomesAcross(roots: string[]): Map<number, PrOutcome> {
    const byPr = new Map<number, PrOutcome>();
    for (const root of roots) {
        for (const outcome of readOutcomeFile(root)) {
            const known = byPr.get(outcome.pr);
            if (!known || better(outcome, known)) byPr.set(outcome.pr, outcome);
        }
    }
    return byPr;
}

function better(a: PrOutcome, b: PrOutcome): boolean {
    if (a.settled !== b.settled) return a.settled;
    return (a.checkedAt ?? '') > (b.checkedAt ?? '');
}

function readOutcomeFile(root: string): PrOutcome[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, '.rigour', 'outcomes.json'), 'utf8'));
        const all = parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === 'object' ? Object.values(parsed.outcomes) : [];
        return (all as PrOutcome[]).filter(o => o && typeof o.pr === 'number' && typeof o.mergedAt === 'string');
    } catch {
        return [];
    }
}

/** The review lessons every checkout keeps, each once by id. */
export function lessonsAcross(roots: string[]): ReviewLesson[] {
    const byId = new Map<string, ReviewLesson>();
    for (const root of roots) for (const lesson of safeLessons(root)) if (!byId.has(lesson.id)) byId.set(lesson.id, lesson);
    return [...byId.values()];
}

function safeLessons(root: string): ReviewLesson[] {
    try {
        return readLessons(root);
    } catch {
        return [];
    }
}

/** A review's record and the names of the rules its verdict found broken, found by the commit it reviewed. */
export interface RecordRead { record: ReviewRecord; brokenRules: string[] }

/** The reviewer's folder in the common git folder, beside the threads. */
export function reviewerDir(cwd: string): string | undefined {
    const dir = threadsDir(cwd);
    return dir ? path.join(dir, '..', '..', 'rigour-reviewer') : undefined;
}

/**
 * Finds the record for a review event: among the records of the commit it ran on, the one with the event's integrity
 * hash; without a hash, the latest. Undefined when the store has none (another machine, or a review before records).
 * The folder is listed once per reader.
 */
export function recordReader(dir: string | undefined): (head: unknown, integrity: unknown) => RecordRead | undefined {
    let names: string[] | undefined;
    return (head, integrity) => {
        if (!dir || typeof head !== 'string' || !/^[0-9a-f]{7,64}$/.test(head)) return undefined;
        names ??= listDir(dir).filter(f => f.endsWith('.record.json'));
        const reads = names.filter(f => f.startsWith(`${head}.`)).flatMap(name => {
            const record = readJson<ReviewRecord>(path.join(dir, name));
            return record?.verified ? [{ name, record }] : [];
        }).sort((a, b) => (a.record.at ?? '').localeCompare(b.record.at ?? ''));
        const found = typeof integrity === 'string' ? reads.find(r => r.record.integrity === integrity) : reads.at(-1);
        if (!found) return undefined;
        return { record: found.record, brokenRules: brokenRules(path.join(dir, found.name.replace(/\.record\.json$/, '.json'))) };
    };
}

function listDir(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

/** The rules the verdict found broken, by their own words, shortened. */
function brokenRules(verdictFile: string): string[] {
    const verdict = readJson<{ rules?: Array<{ status?: string; rule?: string; id?: string }> }>(verdictFile);
    return (verdict?.rules ?? []).filter(r => r.status === 'broken').map(r => short(r.rule ?? r.id ?? 'a rule', 140));
}

export function short(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

export function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}
