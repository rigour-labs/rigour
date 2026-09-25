import ts from 'typescript';

const SHELL_MODULES = new Set(['child_process', 'node:child_process']);
const EXEC_METHODS = new Set(['exec', 'execSync']);
const SPAWN_METHODS = new Set(['spawn', 'spawnSync']);
const USER_INPUT = /\b(?:req|request|query|params|body|input|user|argv)\b|process\.env/;

interface ShellBindings {
    functions: Map<string, string>;
    namespaces: Set<string>;
}

export interface UnsafeShellCall {
    line: number;
    text: string;
}

function shellModule(node: ts.Node): boolean {
    return ts.isStringLiteral(node) && SHELL_MODULES.has(node.text);
}

function isShellRequire(node: ts.Node): boolean {
    return ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && node.arguments.length === 1
        && shellModule(node.arguments[0]);
}

function collectBindings(source: ts.SourceFile): ShellBindings {
    const bindings: ShellBindings = { functions: new Map(), namespaces: new Set() };
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && shellModule(statement.moduleSpecifier)) {
            const clause = statement.importClause;
            if (clause?.name) bindings.namespaces.add(clause.name.text);
            const named = clause?.namedBindings;
            if (named && ts.isNamespaceImport(named)) bindings.namespaces.add(named.name.text);
            if (named && ts.isNamedImports(named)) {
                for (const element of named.elements) {
                    const exported = element.propertyName?.text ?? element.name.text;
                    if (EXEC_METHODS.has(exported) || SPAWN_METHODS.has(exported)) {
                        bindings.functions.set(element.name.text, exported);
                    }
                }
            }
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer;
            if (!initializer) continue;
            if (isShellRequire(initializer)) {
                if (ts.isIdentifier(declaration.name)) bindings.namespaces.add(declaration.name.text);
                if (ts.isObjectBindingPattern(declaration.name)) {
                    for (const element of declaration.name.elements) {
                        const exported = element.propertyName?.getText(source) ?? element.name.getText(source);
                        if ((EXEC_METHODS.has(exported) || SPAWN_METHODS.has(exported)) && ts.isIdentifier(element.name)) {
                            bindings.functions.set(element.name.text, exported);
                        }
                    }
                }
            } else if (ts.isPropertyAccessExpression(initializer) && isShellRequire(initializer.expression)
                && ts.isIdentifier(declaration.name)) {
                bindings.functions.set(declaration.name.text, initializer.name.text);
            }
        }
    }
    return bindings;
}

function shadowsImportedName(node: ts.Node, name: string): boolean {
    for (let scope = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
        if (ts.isFunctionLike(scope) && scope.parameters.some(param => ts.isIdentifier(param.name) && param.name.text === name)) {
            return true;
        }
        if (!ts.isBlock(scope)) continue;
        for (const statement of scope.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true;
            if (!ts.isVariableStatement(statement)) continue;
            if (statement.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === name)) {
                return true;
            }
        }
    }
    return false;
}

function shellMethod(call: ts.CallExpression, bindings: ShellBindings): string | undefined {
    const expression = call.expression;
    if (ts.isIdentifier(expression)) {
        return shadowsImportedName(call, expression.text) ? undefined : bindings.functions.get(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression)) {
        const receiver = expression.expression;
        if (isShellRequire(receiver)) return expression.name.text;
        if (ts.isIdentifier(receiver) && bindings.namespaces.has(receiver.text)
            && !shadowsImportedName(call, receiver.text)) return expression.name.text;
    }
    return undefined;
}

function shellEnabled(call: ts.CallExpression): boolean {
    return call.arguments.some(arg => ts.isObjectLiteralExpression(arg)
        && arg.properties.some(prop => ts.isPropertyAssignment(prop)
            && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
            && prop.name.text === 'shell'
            && prop.initializer.kind === ts.SyntaxKind.TrueKeyword));
}

function taintedArgument(call: ts.CallExpression, source: ts.SourceFile): boolean {
    return call.arguments.some(arg => USER_INPUT.test(arg.getText(source)));
}

export function findUnsafeShellCalls(content: string, file: string): UnsafeShellCall[] {
    const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
    const bindings = collectBindings(source);
    const calls: UnsafeShellCall[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const method = shellMethod(node, bindings);
            const executesShell = method && (EXEC_METHODS.has(method) || (SPAWN_METHODS.has(method) && shellEnabled(node)));
            if (executesShell && taintedArgument(node, source)) {
                calls.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                    text: node.getText(source).slice(0, 120) });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
}
