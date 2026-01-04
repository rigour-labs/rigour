import ts from 'typescript';
import { ASTHandler, ASTHandlerContext } from './base.js';
import { Failure } from '../../types/index.js';
import micromatch from 'micromatch';
import path from 'path';

export class TypeScriptHandler extends ASTHandler {
    supports(file: string): boolean {
        return /\.(ts|js|tsx|jsx)$/.test(file);
    }

    async run(context: ASTHandlerContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const sourceFile = ts.createSourceFile(context.file, context.content, ts.ScriptTarget.Latest, true);
        this.analyzeSourceFile(sourceFile, context.file, failures);
        return failures;
    }

    private analyzeSourceFile(sourceFile: ts.SourceFile, relativePath: string, failures: Failure[]) {
        const astConfig = this.config.ast || {};
        const maxComplexity = astConfig.complexity || 10;
        const maxMethods = astConfig.max_methods || 10;
        const maxParams = astConfig.max_params || 5;

        const visit = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
                const name = this.getNodeName(node);

                if (node.parameters.length > maxParams) {
                    failures.push({
                        id: 'AST_MAX_PARAMS',
                        title: `Function '${name}' has ${node.parameters.length} parameters (max: ${maxParams})`,
                        details: `High parameter count detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Reduce number of parameters or use an options object.`
                    });
                }

                let complexity = 1;
                const countComplexity = (n: ts.Node) => {
                    if (ts.isIfStatement(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ||
                        ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) ||
                        ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isConditionalExpression(n)) {
                        complexity++;
                    }
                    if (ts.isBinaryExpression(n)) {
                        if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                            n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                            complexity++;
                        }
                    }
                    ts.forEachChild(n, countComplexity);
                };
                ts.forEachChild(node, countComplexity);

                if (complexity > maxComplexity) {
                    failures.push({
                        id: 'AST_COMPLEXITY',
                        title: `Function '${name}' has cyclomatic complexity of ${complexity} (max: ${maxComplexity})`,
                        details: `High complexity detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Refactor '${name}' into smaller, more focused functions.`
                    });
                }
            }

            if (ts.isClassDeclaration(node)) {
                const name = node.name?.text || 'Anonymous Class';
                const methods = node.members.filter(ts.isMethodDeclaration);

                if (methods.length > maxMethods) {
                    failures.push({
                        id: 'AST_MAX_METHODS',
                        title: `Class '${name}' has ${methods.length} methods (max: ${maxMethods})`,
                        details: `God Object pattern detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Class '${name}' is becoming too large. Split it into smaller services.`
                    });
                }
            }

            if (ts.isImportDeclaration(node)) {
                const importPath = (node.moduleSpecifier as ts.StringLiteral).text;
                this.checkBoundary(importPath, relativePath, failures);
            }

            ts.forEachChild(node, visit);
        };

        ts.forEachChild(sourceFile, visit);
    }

    private checkBoundary(importPath: string, relativePath: string, failures: Failure[]) {
        const boundaries = (this.config as any).architecture?.boundaries || [];
        for (const rule of boundaries) {
            if (micromatch.isMatch(relativePath, rule.from)) {
                const resolved = importPath.startsWith('.')
                    ? path.join(path.dirname(relativePath), importPath)
                    : importPath;

                if (rule.mode === 'deny' && micromatch.isMatch(resolved, rule.to)) {
                    failures.push({
                        id: 'ARCH_BOUNDARY',
                        title: `Architectural Violation`,
                        details: `'${relativePath}' is forbidden from importing '${importPath}' (denied by boundary rule).`,
                        files: [relativePath],
                        hint: `Remove this import to maintain architectural layering.`
                    });
                }
            }
        }
    }

    private getNodeName(node: ts.Node): string {
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
            return node.name?.getText() || 'anonymous';
        }
        if (ts.isArrowFunction(node)) {
            const parent = node.parent;
            if (ts.isVariableDeclaration(parent)) return parent.name.getText();
            return 'anonymous arrow';
        }
        return 'unknown';
    }
}
