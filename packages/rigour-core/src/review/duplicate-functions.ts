/**
 * Duplicate function: a function the change adds or edits whose body is, line for line, the same as
 * another function's in the files the change touched. Two copies drift: the next fix lands in one.
 * Bodies are compared as code (comments and layout ignored), and only bodies of real size count,
 * so small adapters that happen to match are not reported.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Config, Failure } from '../types/index.js';
import { isTestFile } from './test-files.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const MIN_STATEMENTS = 4;
const MIN_LINES = 6;

interface Body { file: string; name: string; line: number; changed: boolean; key: string }

export function duplicateFunctionFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.duplicate_functions?.enabled) return [];
    const bodies: Body[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!CODE.test(file) || isTestFile(file)) continue;
        bodies.push(...bodiesIn(cwd, file, lines));
    }
    const byKey = new Map<string, Body[]>();
    for (const body of bodies) {
        const same = byKey.get(body.key);
        if (same) same.push(body);
        else byKey.set(body.key, [body]);
    }
    const failures: Failure[] = [];
    for (const same of byKey.values()) {
        if (same.length < 2) continue;
        for (const copy of same.filter(b => b.changed)) {
            const original = same.find(b => b !== copy && (!b.changed || b.file < copy.file || (b.file === copy.file && b.line < copy.line)));
            if (original) failures.push(duplicate(copy, original));
        }
    }
    return failures;
}

function bodiesIn(cwd: string, file: string, changed: Set<number>): Body[] {
    let source: ts.SourceFile;
    let offset = 0; // a Svelte component's script starts below its first line
    try {
        let text = fs.readFileSync(path.join(cwd, file), 'utf8');
        if (file.endsWith('.svelte')) {
            const script = text.match(/<script[^>]*>([\s\S]*?)<\/script>/);
            if (!script || script.index === undefined) return [];
            offset = text.slice(0, script.index + script[0].indexOf(script[1])).split('\n').length - 1;
            text = script[1];
        }
        source = ts.createSourceFile(file.endsWith('.svelte') ? `${file}.ts` : file, text, ts.ScriptTarget.Latest, true);
    } catch {
        return [];
    }
    const found: Body[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body && ts.isBlock(node.body)) {
            const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 + offset;
            const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1 + offset;
            if (node.body.statements.length >= MIN_STATEMENTS && end - start + 1 >= MIN_LINES) {
                const isChanged = [...changed].some(l => l >= start && l <= end);
                found.push({ file, name: nameOf(node) ?? `function at line ${start}`, line: start, changed: isChanged, key: normalized(node.body, source) });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** The body as tokens: comments and whitespace dropped. */
function normalized(body: ts.Block, source: ts.SourceFile): string {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body.getText(source));
    const tokens: string[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push(scanner.getTokenText());
    return tokens.join(' ');
}

function nameOf(node: ts.Node): string | undefined {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    return undefined;
}

function duplicate(copy: Body, original: Body): Failure {
    return {
        id: 'duplicate-function',
        title: 'Duplicate function',
        details: `\`${copy.name}\` has the same body as \`${original.name}\` in \`${original.file}:${original.line}\`: two copies drift, and the next fix lands in one.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [copy.file],
        line: copy.line,
        hint: `Keep one: call \`${original.name}\` (moving it somewhere both can import), or extract the shared body.`,
    };
}
