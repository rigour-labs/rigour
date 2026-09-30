/**
 * The calls a differential test makes, and the test file that records them.
 *
 * The model proposes calls; it never writes test code. A call is kept only if
 * it is `name(...)` with plain literal arguments (strings, numbers, booleans,
 * null, undefined, and arrays or objects of those), so what runs is the
 * function under test on data, nothing else: no file, network or process
 * access can come from model output. Rigour writes the file that runs them.
 */
import ts from 'typescript';

export type Runner = 'vitest' | 'jest';

const MAX_CALLS = 8;

export function safeCalls(name: string, candidates: string[]): string[] {
    const kept = new Set<string>();
    for (const candidate of candidates) {
        const text = candidate.trim().replace(/;$/, '');
        if (kept.size >= MAX_CALLS || text.length > 300) continue;
        const statement = ts.createSourceFile('call.ts', text, ts.ScriptTarget.Latest, true).statements;
        if (statement.length !== 1 || !ts.isExpressionStatement(statement[0])) continue;
        const call = statement[0].expression;
        if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === name
            && !call.typeArguments && call.arguments.every(isLiteralValue)) kept.add(call.getText());
    }
    return [...kept];
}

function isLiteralValue(node: ts.Node): boolean {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(node)) return node.text === 'undefined' || node.text === 'NaN' || node.text === 'Infinity';
    if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(isLiteralValue);
    if (ts.isObjectLiteralExpression(node)) {
        return node.properties.every(p => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isLiteralValue(p.initializer));
    }
    return false;
}

/**
 * A test file that runs each call and records its outcome (a stable rendering of
 * the value, or the error's type and message) to the file named by
 * RIGOUR_DIFF_OUT. It asserts nothing: the verdict is base versus head.
 */
export function testFileSource(runner: Runner, name: string, importPath: string, calls: string[]): string {
    return [
        runner === 'vitest' ? "import { test } from 'vitest';" : '',
        "import { writeFileSync } from 'fs';",
        `import { ${name} } from ${JSON.stringify(importPath)};`,
        '',
        'function render(value: unknown): string {',
        "    const seen = new WeakSet<object>();",
        '    return JSON.stringify(value, (_key, v) => {',
        "        if (typeof v === 'bigint') return `${v}n`;",
        "        if (typeof v === 'function') return '[function]';",
        "        if (v instanceof Map) return { map: [...v.entries()] };",
        "        if (v instanceof Set) return { set: [...v.values()] };",
        "        if (v && typeof v === 'object') { if (seen.has(v)) return '[circular]'; seen.add(v); }",
        "        return v === undefined ? '[undefined]' : v;",
        '    }) ?? "[undefined]";',
        '}',
        '',
        `const calls: Array<[string, () => unknown]> = [`,
        ...calls.map(call => `    [${JSON.stringify(call)}, () => ${call}],`),
        '];',
        '',
        "test('rigour differential calls', async () => {",
        '    const out: Record<string, string> = {};',
        '    for (const [label, run] of calls) {',
        '        try {',
        '            out[label] = `returns ${render(await run())}`;',
        '        } catch (error) {',
        "            const e = error as { constructor?: { name?: string }; message?: string };",
        "            out[label] = `throws ${e?.constructor?.name ?? 'Error'}: ${e?.message ?? String(error)}`;",
        '        }',
        '    }',
        '    writeFileSync(process.env.RIGOUR_DIFF_OUT as string, JSON.stringify(out));',
        '});',
        '',
    ].filter((line, i) => i > 0 || line).join('\n');
}
