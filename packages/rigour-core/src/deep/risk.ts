/**
 * Risk of each changed function: which code is worth a paid model's review.
 *
 * Sending every changed file to a frontier model cost $0.75 per PR on real
 * PRs; most changed functions are glue, rename or plumbing that never carries
 * a defect a reviewer acts on. The router reviews the riskiest functions and
 * leaves the rest to the deterministic gates. Signals are syntactic and cheap
 * (no type checker), so ranking a large PR takes milliseconds.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { changedFunctions, isExported } from './changed-functions.js';
import type { FunctionLike } from '../semantic/ast.js';
import type { RemovedBlock } from '../utils/diff.js';
import { isSpecific, type ReviewLesson } from '../review-learning/lessons.js';

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/i;
/** Tests are reviewed with the change, not routed: their fixtures read as data writes and money, and their callbacks have no callers. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//i;

/** Kinds of operation where a wrong line costs the most; matched on the function's text. */
export const SENSITIVE: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
    { kind: 'data-write', pattern: /\.(?:insert|update|upsert|delete|rpc)\s*\(|\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?\w|\bON CONFLICT\b/ },
    { kind: 'paging', pattern: /\b(?:cursor|offset|nextPage|pageToken|hasMore|limit)\b/i },
    { kind: 'auth', pattern: /\b(?:token|session|password|secret|jwt|permission|role|authori[sz]e)\w*/i },
    { kind: 'money-or-time', pattern: /\b(?:amount|price|cents|currency|refund|timezone|Date\.now|new Date|setTimeout|toISOString)\b/ },
    { kind: 'concurrency', pattern: /\bPromise\.(?:all|race|allSettled)\b|\b(?:mutex|lock|semaphore|retry|backoff)\b/i },
    { kind: 'network', pattern: /\bfetch\w*\s*\(|\bnew Request\s*\(|\bAbort(?:Controller|Signal)\b|\baxios\b|\bhttps?\.request\b/ },
];

export interface RiskSignals {
    exported: boolean;
    async: boolean;
    /** Deepest nesting of branches and loops. */
    nesting: number;
    lines: number;
    /** The change removed more conditions, early returns or throws from this function than it added. */
    removedGuard: boolean;
    /** SENSITIVE kinds this function touches. */
    sensitive: string[];
    /** A verified team lesson about this file that names code this function uses. */
    lesson?: string;
}

export interface FunctionRisk {
    file: string;
    name: string;
    start: number;
    end: number;
    signals: RiskSignals;
    score: number;
    /** sha256 of the function's exact text (line endings normalised): any edit to it changes this. */
    hash: string;
}

/**
 * Score one changed function from its signals; higher is riskier, 0 means
 * "rules only". The router reviews functions at or above `min_score`.
 */
export function scoreRisk(signals: RiskSignals): number {
    // Strong signals clear the default bar (1) on their own; shape alone (size, nesting) never does.
    // A mistake this team already fixed once is as strong a signal as a removed guard.
    let score = signals.removedGuard ? 2 : 0;
    score += signals.lesson ? 2 : 0;
    score += signals.sensitive.includes('data-write') ? 2 : 0;
    // Other sensitive kinds add, capped so a function that mentions everything does not drown the rest.
    score += Math.min(2, signals.sensitive.filter(kind => kind !== 'data-write').length);
    // Weak proxies only add to something already risky, or push a big, branchy public function over.
    score += (signals.nesting >= 3 ? 0.5 : 0) + (signals.lines >= 40 ? 0.5 : 0);
    score += signals.exported && signals.async ? 0.5 : 0;
    return score;
}

/** Changed functions outside tests, riskiest first; `lessons` are the team's verified review lessons in play. */
export function rankChangedFunctions(
    cwd: string, focusLines: Record<string, number[]>, removed: Record<string, RemovedBlock[]> = {}, lessons: ReviewLesson[] = [],
): FunctionRisk[] {
    const ranked: FunctionRisk[] = [];
    for (const [file, lines] of Object.entries(focusLines)) {
        if (!PARSEABLE.test(file) || TEST_FILE.test(file) || lines.length === 0) continue;
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf-8');
        } catch {
            continue;
        }
        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const textLines = text.split('\n');
        for (const fn of changedFunctions(sourceFile, lines)) {
            const start = sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1;
            const end = sourceFile.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
            const added = lines.filter(l => l >= start && l <= end).map(l => textLines[l - 1] ?? '');
            const signals = signalsOf(fn, sourceFile, start, end, removed[file] ?? [], added);
            const lesson = lessonFor(file, fn.getText(sourceFile), lessons);
            if (lesson) signals.lesson = lesson;
            ranked.push({ file, name: nameOf(fn, sourceFile), start, end, signals, score: scoreRisk(signals), hash: functionHash(fn.getText(sourceFile)) });
        }
    }
    return ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.start - b.start);
}

/** The current text hash and span of a named function in a file, if the file parses and has it. */
export function findFunction(cwd: string, file: string, name: string): { hash: string; start: number; end: number } | undefined {
    if (!PARSEABLE.test(file)) return undefined;
    let text: string;
    try {
        text = fs.readFileSync(path.join(cwd, file), 'utf-8');
    } catch {
        return undefined;
    }
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let found: { hash: string; start: number; end: number } | undefined;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
            && node.body && nameOf(node, sourceFile) === name) {
            found = {
                hash: functionHash(node.getText(sourceFile)),
                start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
                end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            };
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

/**
 * What a review record is bound to: the function's exact source. Collapsing whitespace once let
 * `"a  b"` and `"a b"` share a hash, so a string changed after review still counted as reviewed.
 * Only line endings are normalised (a Windows checkout is the same code); any other change,
 * formatting included, asks for a new review.
 */
export function functionHash(text: string): string {
    return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/** The first lesson about this file that names an identifier the function uses (only specific names link code). */
function lessonFor(file: string, body: string, lessons: ReviewLesson[]): string | undefined {
    const forFile = lessons.filter(l => l.file === file);
    if (forFile.length === 0) return undefined;
    const used = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
    return forFile.find(l => l.symbols.some(s => isSpecific(s) && used.has(s)))?.text;
}

const GUARD = /\b(?:if|else|return|throw|break|continue|catch)\b|\?\?|\?\./g;

function guards(lines: string[]): number {
    return lines.reduce((count, line) => count + (line.match(GUARD)?.length ?? 0), 0);
}

function signalsOf(fn: FunctionLike, sourceFile: ts.SourceFile, start: number, end: number, removed: RemovedBlock[], added: string[]): RiskSignals {
    const body = fn.getText(sourceFile);
    const removedLines = removed.filter(block => block.line >= start && block.line <= end + 1).flatMap(block => block.text);
    return {
        exported: isExported(fn),
        async: !!ts.getModifiers(fn)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
        nesting: maxNesting(fn),
        lines: end - start + 1,
        removedGuard: guards(removedLines) > guards(added),
        sensitive: SENSITIVE.filter(s => s.pattern.test(body)).map(s => s.kind),
    };
}

function maxNesting(fn: FunctionLike): number {
    let deepest = 0;
    const walk = (node: ts.Node, depth: number): void => {
        const nests = ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node)
            || ts.isTryStatement(node) || ts.isConditionalExpression(node);
        const next = nests ? depth + 1 : depth;
        deepest = Math.max(deepest, next);
        if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
        ts.forEachChild(node, child => walk(child, next));
    };
    ts.forEachChild(fn, child => walk(child, 0));
    return deepest;
}

function nameOf(fn: FunctionLike, sourceFile: ts.SourceFile): string {
    if (fn.name) return fn.name.getText(sourceFile);
    const parent = fn.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name) return parent.name.getText(sourceFile);
    return `<anonymous>@${sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1}`;
}

