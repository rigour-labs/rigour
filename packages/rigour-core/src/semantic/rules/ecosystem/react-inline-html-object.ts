/**
 * react/inline-html-object: `dangerouslySetInnerHTML={{ __html }}` built inline
 * in a React 19 component.
 *
 * React 19 compares the `__html` object by identity, so a fresh literal on every
 * render rewrites the element's innerHTML each time: inline <style> and <script>
 * tags re-apply and re-execute. TanStack Router fixed its head assets by
 * memoizing the object.
 */
import ts from 'typescript';
import { forEachNode, unwrap } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, isJsxFile } from './shared.js';

export const reactInlineHtmlObject: SemanticRule = {
    id: 'react/inline-html-object',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, project } = ctx;
        if (!isJsxFile(sourceFile) || (project.majorVersion(sourceFile.fileName, 'react') ?? 0) < 19) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || node.name.text !== 'dangerouslySetInnerHTML') return;
            const value = node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression;
            if (value && ts.isObjectLiteralExpression(unwrap(value))) {
                findings.push(finding(ctx, 'react/inline-html-object', node, 'medium',
                    'A new `{ __html }` object on every render makes React 19 rewrite this element\'s innerHTML each render.',
                    'Memoize it: `const html = useMemo(() => ({ __html }), [source])`.'));
            }
        });
        return findings;
    },
};
