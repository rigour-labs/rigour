/**
 * deps/codegen-undeclared-import: generated code imports a package the
 * generating package does not declare.
 *
 * Plugins and compilers emit source into their users' builds. An emitted
 * `import … from 'pkg'` resolves in the user's project, so `pkg` must be a
 * dependency or peer dependency of the plugin; otherwise builds fail wherever
 * the user has not happened to install it. TanStack's Rsbuild plugin emitted
 * `react-refresh/runtime` and broke apps without it.
 *
 * Only text that is emitted as code counts: a template tagged by a code builder
 * (`template.statement\`…\``), the `code` a bundler hook returns, or text given
 * to a MagicString edit. Strings that merely mention imports (docs, lint rule
 * data, demos) do not.
 */
import { builtinModules } from 'module';
import ts from 'typescript';
import { forEachNode, propertyNameText } from '../../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding, packageOf } from './shared.js';

const EMITTED_IMPORT = /(?:^|[\s;{}])import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g;
const BUILTINS = new Set(builtinModules);
const CODE_TAG = /(?:^|\.)(?:template|statement|statements|expression|smart|program|ast|js|ts|jsx|tsx|code)$/;
const EMIT_METHODS = new Set(['prepend', 'append', 'appendLeft', 'appendRight', 'prependLeft', 'prependRight', 'overwrite']);

export const depsCodegenUndeclaredImport: SemanticRule = {
    id: 'deps/codegen-undeclared-import',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, project } = ctx;
        const declared = project.dependencies(sourceFile.fileName);
        if (declared.size === 0) return [];
        const self = project.packageName(sourceFile.fileName);
        const findings: SemanticFinding[] = [];
        forEachNode(sourceFile, (node) => {
            const text = templateText(node);
            if (!text || !isEmittedCode(node)) return;
            for (const match of text.matchAll(EMITTED_IMPORT)) {
                const pkg = packageOf(match[1]);
                if (!pkg || pkg.includes('${') || BUILTINS.has(pkg) || declared.has(pkg) || pkg === self) continue;
                findings.push(finding(ctx, 'deps/codegen-undeclared-import', node, 'high',
                    `Generated code imports \`${match[1]}\`, but \`${pkg}\` is not a dependency or peer dependency of this package; builds without it fail.`,
                    `Declare \`${pkg}\` as a (peer) dependency, or emit code that does not import it.`));
            }
        });
        return findings;
    },
};

/** Text of a string or template that is code: it must contain an import statement, not just a path. */
function templateText(node: ts.Node): string | undefined {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text.includes('import') ? node.text : undefined;
    if (ts.isTemplateExpression(node)) {
        const text = [node.head.text, ...node.templateSpans.map(s => s.literal.text)].join('${}');
        return text.includes('import') ? text : undefined;
    }
    return undefined;
}

/** The string is emitted as module code, not merely text that mentions an import. */
function isEmittedCode(node: ts.Node): boolean {
    const parent = node.parent;
    if (ts.isTaggedTemplateExpression(parent)) return CODE_TAG.test(parent.tag.getText());
    if (ts.isPropertyAssignment(parent) && propertyNameText(parent.name) === 'code') return true;
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
        return EMIT_METHODS.has(parent.expression.name.text) && parent.arguments.includes(node as ts.Expression);
    }
    return false;
}
