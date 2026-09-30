/**
 * dom/self-query-in-component: a component scans the whole document to find
 * its own element.
 *
 * `document.querySelectorAll(...)` inside a component's mount or effect, looping
 * to find the node whose attribute equals this instance's id, costs O(n) per
 * instance and O(n²) per page. A ref gives the element directly. TanStack's
 * Solid hydration did this for every boundary.
 */
import ts from 'typescript';
import { forEachNode } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, isJsxFile } from './shared.js';

const LIFECYCLE = new Set(['onMount', 'createEffect', 'createRenderEffect', 'useEffect', 'useLayoutEffect', 'onMounted', 'watchEffect']);

export const domSelfQueryInComponent: SemanticRule = {
    id: 'dom/self-query-in-component',
    check(ctx: RuleContext): SemanticFinding[] {
        if (!isJsxFile(ctx.sourceFile) && !ctx.sourceFile.fileName.endsWith('.vue.ts')) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(ctx.sourceFile, (node) => {
            if (!ts.isCallExpression(node) || !isDocumentQueryAll(node) || !insideLifecycle(node)) return;
            if (!matchesOwnIdentity(node)) return;
            findings.push(finding(ctx, 'dom/self-query-in-component', node, 'medium',
                'Each instance scans the whole document to find its own element: O(n) per instance, O(n²) per page.',
                'Attach a ref to the element and use it directly.'));
        });
        return findings;
    },
};

function isDocumentQueryAll(call: ts.CallExpression): boolean {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'querySelectorAll'
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'document';
}

function insideLifecycle(node: ts.Node): boolean {
    for (let current = node.parent; current; current = current.parent) {
        if (!ts.isCallExpression(current)) continue;
        const callee = current.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (LIFECYCLE.has(name)) return true; // onMount(...) or Solid.onMount(...)
    }
    return false;
}

/** The query's results are filtered by comparing an attribute to something (the instance's own id). */
function matchesOwnIdentity(query: ts.CallExpression): boolean {
    let scope: ts.Node = query;
    while (scope.parent && !ts.isBlock(scope.parent)) scope = scope.parent;
    const block = scope.parent ?? scope;
    let matches = false;
    forEachNode(block, (node) => {
        if (matches || !ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
        matches = [node.left, node.right].some(side => ts.isCallExpression(side) && ts.isPropertyAccessExpression(side.expression)
            && side.expression.name.text === 'getAttribute');
    });
    return matches;
}
