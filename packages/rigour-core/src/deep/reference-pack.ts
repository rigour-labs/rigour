/**
 * Reference material for reviewing a changed file: what the change means,
 * beyond the file itself.
 *
 * Most bugs reviewers miss need facts outside the changed lines: a guard the
 * change deleted, what a called function actually does, who calls a changed
 * export, what the PR says it intends. The pack carries, within a character
 * budget and in this priority:
 *   1. the PR description,
 *   2. lines the change removed from this file,
 *   3. definitions of functions the changed code calls (resolved by the type checker),
 *   4. call sites of changed exported functions elsewhere in the repository.
 *
 * It is reference only: findings must still cite a line of the reviewed file.
 * Its source joins the identifier check, so a finding may name a callee.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import ts from 'typescript';
import { calledFunction, forEachNode, lineOf, type FunctionLike } from '../semantic/ast.js';
import { changedFunctions, functionName, isExported } from './changed-functions.js';
import { loadProjectConfig, programBatches } from '../semantic/program.js';
import type { RemovedBlock } from '../utils/diff.js';

export interface ReferenceInput {
    cwd: string;
    /** cwd-relative path of the reviewed file. */
    file: string;
    focusLines?: number[];
    removed?: RemovedBlock[];
    prBody?: string;
    maxChars: number;
}

export interface ReferencePack {
    /** Prompt block, empty when there is nothing to add. */
    text: string;
    /** Raw reference source, for identifier verification. */
    source: string;
    /** The prompt sections in priority order, for a second pass that reads them in reverse. */
    sections: string[];
}

const PR_BODY_CHARS = 1500;
const MAX_CALLEES = 6;
const CALLEE_LINES = 40;
const MAX_CALLERS = 5;
const TS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

export function buildReferencePack(input: ReferenceInput): ReferencePack {
    const sections: string[] = [];
    const sources: string[] = [];
    let budget = input.maxChars;
    const add = (title: string, body: string, source = body): void => {
        const block = `${title}\n${body}`;
        if (!body.trim() || block.length > budget) return;
        sections.push(block);
        sources.push(source);
        budget -= block.length + 2;
    };

    if (input.prBody?.trim()) add('PR DESCRIPTION (what the author intends):', input.prBody.trim().slice(0, PR_BODY_CHARS));
    for (const block of input.removed ?? []) {
        add(`REMOVED by this change, just before line ${block.line} of ${input.file}:`, block.text.map(l => `- ${l}`).join('\n'), block.text.join('\n'));
    }
    const change = changeOf(input);
    if (change) {
        for (const callee of calleeDefinitions(input.cwd, change)) add(`CALLED: ${callee.label}`, callee.text);
        for (const caller of callersOfChangedExports(input.cwd, input.file, change)) add(`CALLER of ${caller.name}:`, caller.text);
    }
    return { text: sections.join('\n\n'), source: sources.join('\n'), sections };
}

interface Snippet {
    label: string;
    text: string;
}

interface Change {
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    /** Outermost functions containing a changed line. */
    functions: FunctionLike[];
}

function changeOf(input: ReferenceInput): Change | undefined {
    const focus = input.focusLines ?? [];
    if (focus.length === 0 || !TS_FILE.test(input.file)) return undefined;
    const absolute = path.resolve(input.cwd, input.file);
    const [program] = programBatches([absolute], loadProjectConfig(input.cwd).options, 1);
    const sourceFile = program?.getSourceFile(absolute);
    if (!program || !sourceFile) return undefined;
    return { sourceFile, checker: program.getTypeChecker(), functions: changedFunctions(sourceFile, focus) };
}

/** Definitions, in other files, of functions called from the changed functions. */
function calleeDefinitions(cwd: string, change: Change): Snippet[] {
    const seen = new Set<FunctionLike>();
    const snippets: Snippet[] = [];
    for (const fn of change.functions) {
        forEachNode(fn, (node) => {
            if (snippets.length >= MAX_CALLEES || !ts.isCallExpression(node)) return;
            const target = calledFunction(change.checker, node);
            const where = target?.getSourceFile();
            if (!target || !where || seen.has(target) || where === change.sourceFile || where.isDeclarationFile) return;
            seen.add(target);
            const lines = target.getText(where).split('\n');
            const text = lines.slice(0, CALLEE_LINES).join('\n') + (lines.length > CALLEE_LINES ? `\n… [${lines.length - CALLEE_LINES} more lines]` : '');
            snippets.push({ label: `${path.relative(cwd, where.fileName).split(path.sep).join('/')}:${lineOf(target)}`, text });
        });
    }
    return snippets;
}

/** Call sites, outside this file, of exported functions the change touched. */
function callersOfChangedExports(cwd: string, file: string, change: Change): Array<{ name: string; text: string }> {
    const names = change.functions.filter(isExported).map(functionName).filter((n): n is string => !!n);
    return names.map(name => ({ name, text: grepCallers(cwd, file, name) })).filter(c => c.text);
}

function grepCallers(cwd: string, file: string, name: string): string {
    try {
        const out = execFileSync('git', ['grep', '-n', '-E', '-e', `(^|[^A-Za-z0-9_$])${name}\\(`, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', `:!${file}`], {
            cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.split('\n').filter(Boolean).filter(l => !/\.(?:test|spec)\./.test(l)).slice(0, MAX_CALLERS)
            .map(l => l.length > 200 ? `${l.slice(0, 200)}…` : l).join('\n');
    } catch {
        return '';
    }
}
