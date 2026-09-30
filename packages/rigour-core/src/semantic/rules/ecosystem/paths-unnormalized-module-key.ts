/**
 * paths/unnormalized-module-key: a bundler module's file path is used as a map
 * key or compared with another path without POSIX normalization.
 *
 * Rspack and webpack report modules by OS path (`nameForCondition()`,
 * `.resource`, `.userRequest`), which on Windows uses backslashes, while route
 * generators and Vite ids use forward slashes. The lookup silently misses on
 * Windows only. TanStack Start lost every route's CSS on Windows this way.
 */
import ts from 'typescript';
import { enclosingFunction, forEachNode, forEachOwnNode, symbolOf, unwrap } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

const BUNDLERS = ['@rspack/core', 'webpack', '@rsbuild/core'];
const OS_PATH_PROPERTIES = new Set(['resource', 'userRequest', 'rawRequest']);
const OS_PATH_METHODS = new Set(['nameForCondition']);
const NORMALIZER = /normali[sz]e|posix|slash|toUnix|replace(?:All)?$/i;

export const pathsUnnormalizedModuleKey: SemanticRule = {
    id: 'paths/unnormalized-module-key',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker, project } = ctx;
        if (!project.declares(sourceFile.fileName, ...BUNDLERS)) return [];
        const findings: SemanticFinding[] = [];
        const tainted = new Set<ts.Symbol>();
        forEachNode(sourceFile, (node) => {
            if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
            if (!readsOsPath(checker, node.initializer, tainted)) return;
            const symbol = checker.getSymbolAtLocation(node.name);
            const fn = enclosingFunction(node);
            if (!symbol || !fn) return;
            tainted.add(symbol); // a later variable built from this one carries the OS path too
            const use = keyUse(checker, fn, symbol);
            if (use) {
                findings.push(finding(ctx, 'paths/unnormalized-module-key', node, 'medium',
                    `\`${node.name.text}\` holds a bundler module path in OS form and is used as a lookup key; on Windows it has backslashes and never matches.`,
                    'Normalize it to POSIX separators first (e.g. `.replace(/\\\\/g, \'/\')` or a normalizePath helper).'));
            }
        });
        return findings;
    },
};

/**
 * The expression reads an OS path (from a bundler module, or from a variable that
 * holds one) and is not normalized on the way.
 */
function readsOsPath(checker: ts.TypeChecker, expr: ts.Expression, tainted: Set<ts.Symbol>): boolean {
    let reads = false;
    let normalized = false;
    const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
            if (NORMALIZER.test(name)) normalized = true;
            if (OS_PATH_METHODS.has(name)) reads = true;
        }
        if (ts.isPropertyAccessExpression(node) && OS_PATH_PROPERTIES.has(node.name.text)) reads = true;
        if (ts.isIdentifier(node) && tainted.size > 0) {
            const symbol = symbolOf(checker, node);
            if (symbol && tainted.has(symbol)) reads = true;
        }
        ts.forEachChild(node, walk);
    };
    walk(unwrap(expr));
    return reads && !normalized;
}

/** A use of the variable as a Map key, an object key, or one side of an equality. */
function keyUse(checker: ts.TypeChecker, fn: ts.Node, symbol: ts.Symbol): ts.Node | undefined {
    let use: ts.Node | undefined;
    forEachOwnNode(fn, (node) => {
        if (use || !ts.isIdentifier(node) || symbolOf(checker, node) !== symbol) return;
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isPropertyAccessExpression(parent.expression)
            && ['get', 'set', 'has'].includes(parent.expression.name.text)) use = parent;
        else if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) use = parent;
        else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(parent.operatorToken.kind)) use = parent;
    });
    return use;
}
