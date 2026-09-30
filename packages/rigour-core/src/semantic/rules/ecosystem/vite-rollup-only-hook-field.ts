/**
 * vite/rollup-only-hook-field: a plugin hook returns `syntheticNamedExports`
 * in a package built for Rolldown-based Vite.
 *
 * `syntheticNamedExports` is a Rollup feature Rolldown does not implement, so
 * named imports from the module fail under rolldown-vite (and Vite 7+ on
 * Rolldown). TanStack Start's import protection relied on it and had to emit
 * explicit named exports instead.
 */
import ts from 'typescript';
import { forEachNode, propertyNameText } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

export const viteRollupOnlyHookField: SemanticRule = {
    id: 'vite/rollup-only-hook-field',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, project } = ctx;
        const file = sourceFile.fileName;
        const onRolldown = project.declares(file, 'rolldown', 'rolldown-vite') || (project.majorVersion(file, 'vite') ?? 0) >= 7;
        if (!onRolldown) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
                if (propertyNameText(node.name) !== 'syntheticNamedExports') return;
                findings.push(finding(ctx, 'vite/rollup-only-hook-field', node, 'medium',
                    '`syntheticNamedExports` is Rollup-only; Rolldown-based Vite ignores it, so named imports from this module fail there.',
                    'Emit the named exports explicitly in the generated module.'));
            }
        });
        return findings;
    },
};
