/**
 * vue/static-computed: `computed(() => snapshot)` where `snapshot` is a local
 * built once in setup.
 *
 * A computed re-evaluates only when a reactive source it reads changes. Wrapping
 * a value that setup computed once (say, from props read at setup time) yields
 * a computed that never updates: the props change and the component keeps the
 * first values. TanStack Router's Vue Link lost reactivity this way.
 */
import ts from 'typescript';
import { enclosingFunction, forEachNode, symbolOf, unwrap } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, importsAny } from './shared.js';

export const vueStaticComputed: SemanticRule = {
    id: 'vue/static-computed',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker } = ctx;
        if (!importsAny(sourceFile, ['vue'])) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            if (!ts.isCallExpression(node) || !isComputedCall(node)) return;
            const getter = node.arguments[0];
            if (!getter || !ts.isArrowFunction(getter) || ts.isBlock(getter.body)) return;
            const body = unwrap(getter.body);
            if (!ts.isIdentifier(body)) return;
            const declaration = symbolOf(checker, body)?.valueDeclaration;
            if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
            if (enclosingFunction(declaration) !== enclosingFunction(node) || !isSnapshot(declaration)) return;
            findings.push(finding(ctx, 'vue/static-computed', node, 'medium',
                `\`computed(() => ${body.text})\` wraps a value setup built once, so it never recomputes when props or state change.`,
                'Build the value inside the computed getter, reading props and refs there.'));
        });
        return findings;
    },
};

/** `computed(...)` or `Vue.computed(...)`. */
function isComputedCall(call: ts.CallExpression): boolean {
    const callee = call.expression;
    return (ts.isIdentifier(callee) && callee.text === 'computed')
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'computed');
}

/** A `const` whose initializer is a plain object or array literal: a value, not a reactive source. */
function isSnapshot(declaration: ts.VariableDeclaration): boolean {
    const list = declaration.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    const init = unwrap(declaration.initializer!);
    return isConst && (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init));
}
