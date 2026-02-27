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
        const stalenessConfig = (this.config as any).staleness || {};
        const stalenessRules = stalenessConfig.rules || {};
        const maxComplexity = astConfig.complexity || 10;
        const maxMethods = astConfig.max_methods || 10;
        const maxParams = astConfig.max_params || 5;

        // Limit failures per file to avoid output bloat on large files
        const MAX_FAILURES_PER_FILE = 5;
        const fileFailureCount: Record<string, number> = {};

        const addFailure = (failure: Failure): boolean => {
            const ruleId = failure.id;
            fileFailureCount[ruleId] = (fileFailureCount[ruleId] || 0) + 1;
            if (fileFailureCount[ruleId] <= MAX_FAILURES_PER_FILE) {
                failures.push(failure);
                return true;
            }
            // Add summary failure once when limit is reached
            if (fileFailureCount[ruleId] === MAX_FAILURES_PER_FILE + 1) {
                failures.push({
                    id: `${ruleId}_LIMIT_EXCEEDED`,
                    title: `More than ${MAX_FAILURES_PER_FILE} ${ruleId} violations in ${relativePath}`,
                    details: `Truncated output: showing first ${MAX_FAILURES_PER_FILE} violations. Consider fixing the root cause.`,
                    files: [relativePath],
                    hint: `This file has many violations. Fix them systematically or exclude the file if it's legacy code.`,
                    severity: 'medium',
                    provenance: 'traditional',
                });
            }
            return false;
        };

        // Helper to check if a staleness rule is enabled
        const isRuleEnabled = (rule: string): boolean => {
            if (!stalenessConfig.enabled) return false;
            return stalenessRules[rule] !== false; // Enabled by default if staleness is on
        };

        const visit = (node: ts.Node) => {
            // === STALENESS CHECKS (Rule-based) ===

            // no-var: Forbid legacy 'var' keyword
            if (isRuleEnabled('no-var') && ts.isVariableStatement(node)) {
                const declarationList = node.declarationList;
                // NodeFlags: Let = 1, Const = 2, None = 0 (var)
                if ((declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    addFailure({
                        id: 'STALENESS_NO_VAR',
                        title: `Stale 'var' keyword`,
                        details: `Use 'const' or 'let' instead of 'var' in ${relativePath}:${line}`,
                        files: [relativePath],
                        line,
                        hint: `Replace 'var' with 'const' (preferred) or 'let' for modern JavaScript.`,
                        severity: 'medium',
                        provenance: 'traditional',
                    });
                }
            }

            // no-commonjs: Forbid require() in favor of import
            if (isRuleEnabled('no-commonjs') && ts.isCallExpression(node)) {
                if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    addFailure({
                        id: 'STALENESS_NO_COMMONJS',
                        title: `CommonJS require()`,
                        details: `Use ES6 'import' instead of 'require()' in ${relativePath}:${line}`,
                        files: [relativePath],
                        line,
                        hint: `Replace require('module') with import module from 'module'.`,
                        severity: 'medium',
                        provenance: 'traditional',
                    });
                }
            }

            // no-arguments: Forbid 'arguments' object (use rest params)
            if (isRuleEnabled('no-arguments') && ts.isIdentifier(node) && node.text === 'arguments') {
                // Check if it's actually the arguments keyword and not a variable named arguments
                const parent = node.parent;
                if (!ts.isVariableDeclaration(parent) && !ts.isPropertyAccessExpression(parent)) {
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    addFailure({
                        id: 'STALENESS_NO_ARGUMENTS',
                        title: `Legacy 'arguments' object`,
                        details: `Use rest parameters (...args) instead of 'arguments' in ${relativePath}:${line}`,
                        files: [relativePath],
                        line,
                        hint: `Replace 'arguments' with rest parameters: function(...args) { }`,
                        severity: 'medium',
                        provenance: 'traditional',
                    });
                }
            }

            // === SECURITY CHECKS (Prototype Pollution) ===

            // Check for direct __proto__ access: obj.__proto__
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && node.name.text === '__proto__') {
                const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                addFailure({
                    id: 'SECURITY_PROTOTYPE_POLLUTION',
                    title: `Direct __proto__ access`,
                    details: `Prototype pollution vulnerability in ${relativePath}:${line}`,
                    files: [relativePath],
                    line,
                    hint: `Use Object.getPrototypeOf() or Object.setPrototypeOf() instead of __proto__.`,
                    severity: 'critical',
                    provenance: 'security',
                });
            }

            // Check for bracket notation __proto__ access: obj["__proto__"]
            if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
                const accessKey = node.argumentExpression.text;
                if (accessKey === '__proto__' || accessKey === 'constructor' || accessKey === 'prototype') {
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    addFailure({
                        id: 'SECURITY_PROTOTYPE_POLLUTION',
                        title: `Unsafe bracket notation access to '${accessKey}'`,
                        details: `Potential prototype pollution via bracket notation in ${relativePath}:${line}`,
                        files: [relativePath],
                        line,
                        hint: `Block access to '${accessKey}' property when handling user input. Use allowlist for object keys.`,
                        severity: 'critical',
                        provenance: 'security',
                    });
                }
            }

            // Check for Object.assign with user-controllable input (common prototype pollution pattern)
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const propAccess = node.expression;
                if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === 'Object' &&
                    ts.isIdentifier(propAccess.name) && propAccess.name.text === 'assign') {
                    // This is Object.assign() - warn if first arg is empty object (merge pattern)
                    if (node.arguments.length >= 2) {
                        const firstArg = node.arguments[0];
                        if (ts.isObjectLiteralExpression(firstArg) && firstArg.properties.length === 0) {
                            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                            addFailure({
                                id: 'SECURITY_PROTOTYPE_POLLUTION_MERGE',
                                title: `Object.assign() merge pattern`,
                                details: `Object.assign({}, ...) can propagate prototype pollution in ${relativePath}:${line}`,
                                files: [relativePath],
                                line,
                                hint: `Validate and sanitize source objects before merging. Block __proto__ and constructor keys.`,
                                severity: 'high',
                                provenance: 'security',
                            });
                        }
                    }
                }
            }

            // === COMPLEXITY CHECKS ===

            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
                const name = this.getNodeName(node);

                if (node.parameters.length > maxParams) {
                    addFailure({
                        id: 'AST_MAX_PARAMS',
                        title: `Function '${name}' has ${node.parameters.length} parameters (max: ${maxParams})`,
                        details: `High parameter count detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Reduce number of parameters or use an options object.`,
                        severity: 'medium',
                        provenance: 'traditional',
                    });
                }

                let complexity = 1;
                const countComplexity = (n: ts.Node) => {
                    // Nested functions have their own complexity budget.
                    // Do not attribute their branches to the parent function.
                    if (n !== node && ts.isFunctionLike(n)) {
                        return;
                    }
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
                    addFailure({
                        id: 'AST_COMPLEXITY',
                        title: `Function '${name}' has cyclomatic complexity of ${complexity} (max: ${maxComplexity})`,
                        details: `High complexity detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Refactor '${name}' into smaller, more focused functions.`,
                        severity: 'medium',
                        provenance: 'traditional',
                    });
                }
            }

            if (ts.isClassDeclaration(node)) {
                const name = node.name?.text || 'Anonymous Class';
                const methods = node.members.filter(ts.isMethodDeclaration);

                if (methods.length > maxMethods) {
                    addFailure({
                        id: 'AST_MAX_METHODS',
                        title: `Class '${name}' has ${methods.length} methods (max: ${maxMethods})`,
                        details: `God Object pattern detected in ${relativePath}`,
                        files: [relativePath],
                        hint: `Class '${name}' is becoming too large. Split it into smaller services.`,
                        severity: 'medium',
                        provenance: 'traditional',
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
                        hint: `Remove this import to maintain architectural layering.`,
                        severity: 'high',
                        provenance: 'traditional',
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
