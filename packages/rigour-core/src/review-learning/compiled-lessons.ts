/**
 * A verified lesson turned into a check that runs without a model. Only lessons a person confirmed (accepted, a
 * correction) or that recurred across pull requests qualify, never one an outcome alone promoted. Compilation is a
 * template, not a model: a lesson compiles only when it names its file and its symbols in backticks and says, in so many
 * words, what is wrong:
 *
 *   forbid   "never `a`", "avoid `a`", "do not use `a`", "use `b` instead of `a`"  →  `a` on a changed line is reported
 *   require  "always …", "must …", "every …" naming `a` then `b`                     →  `a` on a changed line with no `b`
 *                                                                                    within REQUIRE_REACH lines is reported
 *
 * A compiled check is stored in .rigour/compiled-checks.json (committed and reviewed with the code) and runs only once a
 * person approved it (`active`). It keeps its lesson's id, never blocks unless the team turns `block` on, and a person
 * can take it back (`withdrawn`), which hands the lesson back to the model reviewer.
 */
import fs from 'fs';
import path from 'path';
import micromatch from 'micromatch';
import type { Config, Failure } from '../types/index.js';
import { execFileSync } from 'child_process';
import { lessonState, readLessons, type ReviewLesson } from './lessons.js';
import { branchBase } from '../gates/logic-drift-git-base.js';
import { threadReviews } from '../outcomes/run.js';
import { parseDiff } from '../utils/diff.js';

const STORE = path.join('.rigour', 'compiled-checks.json');
/** How far from the trigger line the required symbol may sit for a `require` check. */
const REQUIRE_REACH = 3;

export interface CompiledCheck {
    id: string;
    lessonId: string;
    /** The files it applies to: the lesson's file, or a glob a person widened it to. */
    files: string;
    kind: 'forbid' | 'require';
    /** The symbol that triggers it. */
    symbol: string;
    /** For `require`: the symbol that must be near the trigger. */
    with?: string;
    message: string;
    /** Proposed by `compileLesson`; runs only once `active` (a person approved it); `withdrawn` when taken back. */
    state: 'proposed' | 'active' | 'withdrawn';
    by?: string;
    at: string;
    /**
     * The check run over the main branch's history, for the person who approves it: on merged pull requests a review
     * found the lesson repeating in (it should fire), and on every other merged change to its files (each fire is a
     * false one, or a catch the review missed). Counts, never a rate below RATE_MIN.
     */
    backtest?: { repeating: { fired: number; n: number }; other: { fired: number; n: number }; commits: number; at: string };
}

/** Fewer than this: a count, never a rate. */
export const RATE_MIN = 10;
/** Merged changes to a check's files read back, newest first. */
const BACKTEST_COMMITS = 100;
/** Each backtest stops here and keeps what it counted. */
const BACKTEST_DEADLINE_MS = 20_000;

const FORBID = [
    /\b(?:use|prefer)\s+`([^`]+)`\s+(?:instead of|over|rather than)\s+`([^`]+)`/i, // the second is forbidden
    /\b(?:never|avoid|don't|do not|must not|should not|no longer)\b[^.`]*`([^`]+)`/i,
];
const REQUIRE = /\b(?:always|must|every|needs? to|has to)\b/i;

/** Whether a lesson may be compiled: verified by a person, a correction or recurrence, never by an outcome alone. */
function compilable(lesson: ReviewLesson): boolean {
    const { state, promotedBy } = lessonState(lesson);
    return state === 'verified' && (promotedBy === 'person' || promotedBy === 'correction' || promotedBy === 'recurrence') && !!lesson.file && lesson.symbols.length > 0;
}

/** The check a lesson compiles to, proposed for a person to approve; undefined when no template fits it. */
function compileLesson(lesson: ReviewLesson, at = new Date().toISOString()): CompiledCheck | undefined {
    if (!compilable(lesson)) return undefined;
    const named = (s: string | undefined) => (s && lesson.symbols.includes(s.replace(/\(\)$/, '')) ? s.replace(/\(\)$/, '') : undefined);
    const base = { id: `c-${lesson.id}`, lessonId: lesson.id, files: lesson.file, message: lesson.text, state: 'proposed' as const, at };
    const instead = FORBID[0].exec(lesson.text);
    const forbidden = instead ? named(instead[2]) : named(FORBID[1].exec(lesson.text)?.[1]);
    if (forbidden) return { ...base, kind: 'forbid', symbol: forbidden };
    if (REQUIRE.test(lesson.text)) {
        const ticked = [...lesson.text.matchAll(/`([^`]+)`/g)].map(m => named(m[1])).filter((s): s is string => !!s);
        if (ticked.length >= 2 && ticked[0] !== ticked[1]) return { ...base, kind: 'require', symbol: ticked[0], with: ticked[1] };
    }
    return undefined;
}

/**
 * Proposes a check for every compilable lesson that has none yet, and backtests every check still proposed against the
 * main branch's history; returns the new proposals. A decided check is never re-proposed.
 */
export function proposeCompiledChecks(cwd: string): CompiledCheck[] {
    const checks = readCompiledChecks(cwd);
    const known = new Set(checks.map(c => c.lessonId));
    const proposed = readLessons(cwd).filter(l => !known.has(l.id)).map(l => compileLesson(l)).filter((c): c is CompiledCheck => !!c);
    const all = [...checks, ...proposed];
    withBacktests(cwd, all);
    if (all.length) writeCompiledChecks(cwd, all);
    return proposed;
}

/** A person's decision on a compiled check: approve it (it runs) or take it back (it stops). Undefined when there is no such check. */
export function decideCompiledCheck(cwd: string, id: string, state: 'active' | 'withdrawn', by: string): CompiledCheck | undefined {
    if (!by.trim()) throw new Error('a compiled check is decided by a named person: their git email is committed with it');
    const checks = readCompiledChecks(cwd);
    const check = checks.find(c => c.id === id);
    if (!check) return undefined;
    Object.assign(check, { state, by, at: new Date().toISOString() });
    writeCompiledChecks(cwd, checks);
    return check;
}

export function readCompiledChecks(cwd: string): CompiledCheck[] {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(cwd, STORE), 'utf8'));
        return Array.isArray(data?.checks) ? data.checks : [];
    } catch {
        return [];
    }
}

function writeCompiledChecks(cwd: string, checks: CompiledCheck[]): void {
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, STORE), `${JSON.stringify({ version: 1, checks }, null, 2)}\n`);
}

const word = (symbol: string) => new RegExp(`(^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`);

/** Whether a check applies to a file: the file itself, or a glob it was widened to. */
function covers(check: CompiledCheck, file: string): boolean {
    return /[*?[\]{}]/.test(check.files) ? micromatch.isMatch(file, check.files, { dot: true }) : check.files === file;
}

/** The active compiled checks' findings on the change's lines: notes unless the team blocks on them. */
export function compiledLessonFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    const settings = config.gates.compiled_lessons;
    if (!settings?.enabled) return [];
    const checks = readCompiledChecks(cwd).filter(c => c.state === 'active');
    if (checks.length === 0) return [];
    const failures: Failure[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        const applying = checks.filter(c => covers(c, file));
        if (applying.length === 0) continue;
        let text: string[];
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf8').split('\n');
        } catch {
            continue;
        }
        for (const check of applying) {
            for (const line of firesOn(check, text, lines)) {
                failures.push({
                    id: 'compiled-lesson',
                    ...(settings.block ? {} : { advisory: true }),
                    title: check.kind === 'forbid' ? `\`${check.symbol}\`: the team's lesson says not to` : `\`${check.symbol}\` without \`${check.with}\`: the team's lesson says to pair them`,
                    details: `${check.message} (compiled from lesson ${check.lessonId}; a person approved it)`,
                    severity: 'medium',
                    provenance: 'traditional',
                    files: [file],
                    line,
                    hint: `Follow the lesson, or take the compiled check back in Studio if it no longer holds (lesson ${check.lessonId}).`,
                });
            }
        }
    }
    return failures;
}

/** The changed lines a check fires on, in a file's text. */
function firesOn(check: CompiledCheck, text: string[], lines: Iterable<number>): number[] {
    const trigger = word(check.symbol);
    return [...lines].sort((a, b) => a - b).filter(line => {
        if (!trigger.test(text[line - 1] ?? '')) return false;
        if (check.kind === 'forbid') return true;
        return !word(check.with!).test(text.slice(Math.max(0, line - 1 - REQUIRE_REACH), line + REQUIRE_REACH).join('\n'));
    });
}

/**
 * Runs a check over the main branch's last BACKTEST_COMMITS changes to its files: per change, whether it fires on the
 * lines that change added, split by whether a review found the lesson repeating in that pull request. Read-only, no model.
 */
function backtestCheck(cwd: string, check: CompiledCheck, mainRef: string, applied: Map<number, Set<string>>): NonNullable<CompiledCheck['backtest']> {
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
    const spec = /[*?[\]{}]/.test(check.files) ? `:(glob)${check.files}` : check.files;
    const result = { repeating: { fired: 0, n: 0 }, other: { fired: 0, n: 0 }, commits: 0, at: new Date().toISOString() };
    const deadline = Date.now() + BACKTEST_DEADLINE_MS;
    let log = '';
    try {
        log = git(['log', '--first-parent', '-n', String(BACKTEST_COMMITS), '--format=%H %s', mainRef, '--', spec]);
    } catch {
        return result;
    }
    for (const entry of log.split('\n').filter(Boolean)) {
        if (Date.now() > deadline) break;
        const [sha, ...subject] = entry.split(' ');
        const pr = Number(/\(#(\d+)\)\s*$|Merge pull request #(\d+)/.exec(subject.join(' '))?.slice(1).find(Boolean));
        let fired = false;
        try {
            for (const [file, lines] of Object.entries(parseDiff(git(['diff', '-U0', `${sha}^1`, sha, '--', spec])))) {
                if (firesOn(check, git(['show', `${sha}:${file}`]).split('\n'), lines).length) fired = true;
            }
        } catch {
            continue; // a root commit or a file the commit removed: nothing to count
        }
        const bucket = pr && applied.get(pr)?.has(check.lessonId) ? result.repeating : result.other;
        bucket.n++;
        if (fired) bucket.fired++;
        result.commits++;
    }
    return result;
}

/** Re-runs the backtest of every check still proposed: what the person approving it reads. */
function withBacktests(cwd: string, checks: CompiledCheck[]): void {
    const mainRef = branchBase(cwd)?.mainRef;
    if (!mainRef) return;
    const { applied } = threadReviews(cwd);
    for (const check of checks) if (check.state === 'proposed') check.backtest = backtestCheck(cwd, check, mainRef, applied);
}
