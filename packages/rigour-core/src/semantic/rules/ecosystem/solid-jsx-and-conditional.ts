/**
 * solid/jsx-and-conditional: `{cond && <X/>}` in a Solid component.
 *
 * The React idiom. In Solid, JSX expressions compile to reactive getters, so the
 * branch is recreated whenever the expression re-runs and ownership of the
 * element is not tracked; `<Show when={cond}>` is the keyed, disposed form.
 * TanStack Router shipped this in its Solid adapter and fixed it with <Show>.
 */
import ts from 'typescript';
import { forEachNode, unwrap } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, importsAny, isJsxFile } from './shared.js';

export const solidJsxAndConditional: SemanticRule = {
    id: 'solid/jsx-and-conditional',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile } = ctx;
        if (!isJsxFile(sourceFile) || !importsAny(sourceFile, ['solid-js'])) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            if (!ts.isJsxExpression(node) || !node.expression || !isJsxChild(node)) return;
            const expr = unwrap(node.expression);
            if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isJsx(unwrap(expr.right))) {
                findings.push(finding(ctx, 'solid/jsx-and-conditional', node, 'medium',
                    '`cond && <X/>` is the React idiom; in Solid the branch is not keyed or disposed when `cond` changes.',
                    'Use <Show when={cond}>…</Show>.'));
            }
        });
        return findings;
    },
};

/** Inside JSX children, not an attribute value. */
function isJsxChild(node: ts.JsxExpression): boolean {
    return ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
}

function isJsx(node: ts.Node): boolean {
    return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}
