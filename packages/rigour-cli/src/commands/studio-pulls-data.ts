/**
 * What the Pull requests page reads, as Rigour wrote it: the task threads in the common git folder, every checkout's
 * outcomes.json and review-lessons.json, and the reviewer's records beside its verdicts. Read only; a file that is
 * missing or does not parse reads as nothing recorded.
 */
import fs from 'fs';
import path from 'path';
import { readLessons, threadsDir, type PrOutcome, type ReviewLesson, type ReviewRecord, type ThreadEvent } from '@rigour-labs/core';
import { isThreadLine, jsonLines, readJsonFile } from './studio-files.js';

/**
 * The threads written to since `since` (a thread is only appended to, so an older file holds no newer line), one per
 * branch file, each oldest first; lines that do not parse are skipped. `older` counts the thread files left out.
 */
export function readThreadsSince(cwd: string, since: number): { threads: ThreadEvent[][]; older: number } {
    const dir = threadsDir(cwd);
    if (!dir) return { threads: [], older: 0 };
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
    } catch {
        return { threads: [], older: 0 };
    }
    const recent = files.filter(file => modifiedSince(file, since));
    const threads = recent.map(readEvents).filter(events => events.length > 0);
    return { threads, older: files.length - recent.length };
}

function modifiedSince(file: string, since: number): boolean {
    try {
        return fs.statSync(file).mtimeMs >= since;
    } catch {
        return false;
    }
}

function readEvents(file: string): ThreadEvent[] {
    return jsonLines<ThreadEvent>(file).filter(isThreadLine).sort((a, b) => a.at.localeCompare(b.at));
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
    const parsed = readJsonFile<{ version?: unknown; outcomes?: unknown }>(path.join(root, '.rigour', 'outcomes.json'));
    const all = parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === 'object' ? Object.values(parsed.outcomes) : [];
    return (all as PrOutcome[]).filter(o => o && typeof o.pr === 'number' && typeof o.mergedAt === 'string');
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
            const record = readJsonFile<ReviewRecord>(path.join(dir, name));
            return record && typeof record === 'object' && record.verified ? [{ name, record }] : [];
        }).sort((a, b) => recordAt(a.record).localeCompare(recordAt(b.record)));
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
    const verdict = readJsonFile<{ rules?: Array<{ status?: string; rule?: string; id?: string }> }>(verdictFile);
    const rules = Array.isArray(verdict?.rules) ? verdict.rules : [];
    return rules.filter(r => r?.status === 'broken').map(r => short(typeof r.rule === 'string' ? r.rule : typeof r.id === 'string' ? r.id : 'a rule', 140));
}

export function short(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function recordAt(record: ReviewRecord): string {
    return typeof record.at === 'string' ? record.at : '';
}

export function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}
