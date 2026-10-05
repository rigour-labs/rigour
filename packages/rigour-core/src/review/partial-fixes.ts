/**
 * Partial fix: a change names a broader condition (`const hasSaved = a.length > 0 || count > 0`)
 * and uses it at some call sites, while the narrower condition it replaces (`count > 0`) is still
 * tested on its own elsewhere in the same folder (the same route's other file, a sibling page).
 * "Fixed" means every case, so the places still using the old form are named. Reported on the
 * line that adds the named condition, since the leftovers are, by definition, lines it did not touch.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Config, Failure } from '../types/index.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const SKIPPED = /\.(test|spec)\.|\.d\.ts$/;

interface Part { text: string; pattern: RegExp }

export function partialFixFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.change_sweep?.enabled) return [];
    const failures: Failure[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) || SKIPPED.test(file) || lines.size === 0) continue;
        const source = parse(cwd, file);
        if (!source) continue;
        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isOr(node.initializer)) {
                const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                if (lines.has(line)) {
                    const leftovers = narrowerElsewhere(cwd, file, line, parts(node.initializer, source), changedLines);
                    if (leftovers.length) failures.push(partial(file, line, node.name.text, leftovers));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return failures;
}

function isOr(expr: ts.Expression): boolean {
    const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken;
}

/**
 * The comparisons a broader condition ORs together. A comparison on a property (`x.count > 0`)
 * matches the same property, operator and value on any receiver (`data.x.count > 0`).
 */
function parts(expr: ts.Expression, source: ts.SourceFile): Part[] {
    const found: Part[] = [];
    const walk = (e: ts.Expression) => {
        const inner = ts.isParenthesizedExpression(e) ? e.expression : e;
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            walk(inner.left);
            walk(inner.right);
            return;
        }
        if (ts.isBinaryExpression(inner) && isComparison(inner.operatorToken.kind) && ts.isPropertyAccessExpression(inner.left) && isLiteral(inner.right)) {
            // The receiver's last name and the property (`answers.length`, `snapshot.answeredCount`): specific
            // enough that an unrelated `.length > 0` never matches, loose enough for `data.snapshot.answeredCount`.
            const receiver = inner.left.expression;
            const owner = ts.isIdentifier(receiver) ? receiver.text : ts.isPropertyAccessExpression(receiver) ? receiver.name.text : undefined;
            if (!owner) return;
            const tail = `${owner}.${inner.left.name.text}`;
            const operator = inner.operatorToken.getText(source);
            const value = inner.right.getText(source);
            found.push({
                text: inner.getText(source),
                pattern: new RegExp(`(?<![\\w$])${escape(tail)}\\s*${escape(operator)}\\s*${escape(value)}(?![\\w.])`),
            });
        }
    };
    walk(expr);
    return found;
}

function isComparison(kind: ts.SyntaxKind): boolean {
    return [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(kind);
}

function isLiteral(e: ts.Expression): boolean {
    return ts.isNumericLiteral(e) || ts.isStringLiteral(e) || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
}

/** `file:line` of each remaining standalone use of a part, in the same folder, outside the broader condition. */
function narrowerElsewhere(cwd: string, file: string, declLine: number, found: Part[], changed: Record<string, Set<number>>): string[] {
    if (found.length < 2) return [];
    const dir = path.posix.dirname(file);
    let siblings: string[];
    try {
        siblings = fs.readdirSync(path.join(cwd, dir)).filter(name => CODE.test(name) && !SKIPPED.test(name)).map(name => path.posix.join(dir, name));
    } catch {
        return [];
    }
    const leftovers: string[] = [];
    for (const sibling of siblings) {
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, sibling), 'utf8');
        } catch {
            continue;
        }
        text.split('\n').forEach((content, index) => {
            const line = index + 1;
            if (sibling === file && line === declLine) return;
            // A line the change itself added is the author's current intent, not a leftover.
            if (changed[sibling]?.has(line) && sibling === file) return;
            if (found.some(part => part.pattern.test(content)) && !found.every(part => part.pattern.test(content))) leftovers.push(`${sibling}:${line}`);
        });
    }
    return leftovers;
}

function parse(cwd: string, file: string): ts.SourceFile | undefined {
    try {
        return ts.createSourceFile(file, fs.readFileSync(path.join(cwd, file), 'utf8'), ts.ScriptTarget.Latest, true);
    } catch {
        return undefined;
    }
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partial(file: string, line: number, name: string, leftovers: string[]): Failure {
    const listed = leftovers.slice(0, 5).map(l => `\`${l}\``).join(', ');
    return {
        id: 'partial-fix',
        title: 'Partial fix',
        details: `\`${name}\` widens a condition, but the narrower form is still tested on its own at ${listed}${leftovers.length > 5 ? ` and ${leftovers.length - 5} more` : ''}.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line,
        hint: `Use \`${name}\` (or the same condition) at each of those places too, or say in a comment why the narrower test is right there.`,
    };
}
