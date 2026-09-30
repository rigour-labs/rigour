/**
 * env/bare-browser-global: a browser global used bare (`addEventListener(...)`,
 * `history.x`) in a file that knows it may run outside a browser.
 *
 * The file qualifies the global as `window.x` elsewhere, compares against
 * `window`, or checks `isServer` / `typeof window`: it runs where the global is
 * absent or is not the window (SSR, Node with a jsdom window, workers). A bare
 * use there throws or reaches the wrong object. TanStack Router's core crashed
 * router creation under Node + jsdom this way.
 */
import ts from 'typescript';
import { forEachNode } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

const BARE_CALLS = new Set(['addEventListener', 'removeEventListener', 'dispatchEvent']);
const BARE_OBJECTS = new Set(['history', 'location', 'localStorage', 'sessionStorage']);
/** The file guards for non-browser runtimes: `isServer`, `typeof window`/`document`, or compares against `window`. */
const ENV_AWARE = /\bisServer\b|typeof\s+(?:window|document)\b|[=!]==?\s*window\b|\bwindow\s*[=!]==?/;

export const envBareBrowserGlobal: SemanticRule = {
    id: 'env/bare-browser-global',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker } = ctx;
        const qualified = windowQualified(sourceFile);
        const aware = qualified.size > 0 || ENV_AWARE.test(sourceFile.text);
        if (!aware) return [];
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            const bare = bareGlobal(node);
            if (!bare || isLocal(checker, bare)) return;
            findings.push(finding(ctx, 'env/bare-browser-global', node, 'medium',
                `Bare \`${bare.text}\` in a file that also runs outside the browser; where the global is not the window (SSR, jsdom, workers) it throws or hits the wrong object.`,
                `Use \`window.${bare.text}\` as the rest of the file does.`));
        });
        return findings;
    },
};

/** Names the file reads as `window.<name>`. */
function windowQualified(sourceFile: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    forEachNode(sourceFile, (node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'window'
            && (BARE_CALLS.has(node.name.text) || BARE_OBJECTS.has(node.name.text))) names.add(node.name.text);
    });
    return names;
}

function bareGlobal(node: ts.Node): ts.Identifier | undefined {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BARE_CALLS.has(node.expression.text)) return node.expression;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && BARE_OBJECTS.has(node.expression.text)) return node.expression;
    return undefined;
}

/** Declared in the project (an import, a parameter, a local): not the browser global. */
function isLocal(checker: ts.TypeChecker, id: ts.Identifier): boolean {
    const declarations = checker.getSymbolAtLocation(id)?.declarations ?? [];
    return declarations.some(d => !d.getSourceFile().isDeclarationFile);
}
