/**
 * deps/internal-symbol: reading a library's internal `Symbol.for('<lib>.internal…')`
 * with the type error silenced.
 *
 * Internal symbols change without notice between releases, and the
 * `@ts-expect-error` hides exactly the signal that the value is not public API.
 * TanStack Start read h3's internal response symbol and replaced it with the
 * public `event.res`.
 */
import ts from 'typescript';
import { forEachNode } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, leadingCommentText } from './shared.js';

const INTERNAL_KEY = /(?:^|[.:/])(?:internal|private)(?:[.:/]|$)/i;
const SILENCED = /@ts-(?:expect-error|ignore)/;

export const depsInternalSymbol: SemanticRule = {
    id: 'deps/internal-symbol',
    check(ctx: RuleContext): SemanticFinding[] {
        const findings: SemanticFinding[] = [];
        forEachNode(ctx.sourceFile, (node) => {
            if (!ts.isCallExpression(node) || !isSymbolFor(node)) return;
            const key = node.arguments[0];
            if (!key || !ts.isStringLiteralLike(key) || !INTERNAL_KEY.test(key.text)) return;
            if (!SILENCED.test(leadingCommentText(ctx.sourceFile, node))) return;
            findings.push(finding(ctx, 'deps/internal-symbol', node, 'medium',
                `\`Symbol.for('${key.text}')\` reads a library internal with the type error silenced; it can break on any release.`,
                'Use the library\'s public API for this value, or pin the version and cover it with a test.'));
        });
        return findings;
    },
};

function isSymbolFor(call: ts.CallExpression): boolean {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'for'
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'Symbol';
}
