/**
 * ts/internal-in-public-signature: an exported function destructures an
 * `@internal` property of its parameter while tsconfig sets `stripInternal`.
 *
 * `stripInternal` removes the property from the parameter's type in the emitted
 * .d.ts, but the emitted signature still destructures it, so the published
 * declarations do not type-check for consumers. TanStack Router shipped this in
 * interpolatePath and fixed it with a rest parameter.
 */
import ts from 'typescript';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

export const tsInternalInPublicSignature: SemanticRule = {
    id: 'ts/internal-in-public-signature',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker, project } = ctx;
        if (sourceFile.isDeclarationFile || !project.compilerOptions(sourceFile.fileName).stripInternal) return [];
        const findings: SemanticFinding[] = [];
        for (const fn of exportedFunctions(sourceFile)) {
            for (const param of fn.parameters) {
                if (!ts.isObjectBindingPattern(param.name)) continue;
                const type = checker.getTypeAtLocation(param);
                for (const element of param.name.elements) {
                    const name = element.propertyName ?? element.name;
                    if (!ts.isIdentifier(name) || element.dotDotDotToken) continue;
                    const property = type.getProperty(name.text);
                    if (property && isInternal(property)) {
                        findings.push(finding(ctx, 'ts/internal-in-public-signature', element, 'high',
                            `Exported \`${functionName(fn)}\` destructures \`${name.text}\`, which is @internal; stripInternal removes it from the published type, so the emitted .d.ts does not compile.`,
                            `Take the rest (\`...rest\`) and read \`rest.${name.text}\`, or stop marking the property @internal.`));
                    }
                }
            }
        }
        return findings;
    },
};

type ExportedFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function exportedFunctions(sourceFile: ts.SourceFile): ExportedFunction[] {
    const found: ExportedFunction[] = [];
    for (const statement of sourceFile.statements) {
        if (!isExported(statement)) continue;
        if (ts.isFunctionDeclaration(statement)) found.push(statement);
        if (ts.isVariableStatement(statement)) {
            for (const decl of statement.declarationList.declarations) {
                const init = decl.initializer;
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) found.push(init);
            }
        }
    }
    return found;
}

function isExported(statement: ts.Statement): boolean {
    return ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isInternal(property: ts.Symbol): boolean {
    return (property.declarations ?? []).some(decl => ts.getJSDocTags(decl).some(tag => tag.tagName.text === 'internal'));
}

function functionName(fn: ExportedFunction): string {
    if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? 'default';
    const decl = fn.parent;
    return ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : 'function';
}
