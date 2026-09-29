/**
 * Deprecated JS/TS constructs that need the syntax tree to detect reliably.
 *
 * A `with` statement is found from the parsed tree, so the words "with (" in
 * a comment, a string or an identifier never match.
 */
import ts from 'typescript';

export interface AstDeprecation {
    line: number;
    api: string;
    reason: string;
    replacement: string;
    category: 'removed';
}

export function findWithStatements(content: string, file: string): AstDeprecation[] {
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const found: AstDeprecation[] = [];
    const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.WithStatement) {
            found.push({
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                api: 'with statement',
                reason: 'Removed in strict mode, creates ambiguous scope, security risk',
                replacement: 'Destructuring or explicit property access',
                category: 'removed',
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}
