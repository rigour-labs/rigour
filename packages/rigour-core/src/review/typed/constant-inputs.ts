/**
 * Inputs that never vary in production, so the code that handles other values is dead:
 *
 *   constant-member    a property every production object of the type sets to the same literal
 *                      (`count: 0` in each), while code branches on it: the other branches never run.
 *   constant-argument  a parameter every production call passes the same literal, while the body
 *                      branches on it: the other branch never runs outside tests.
 *
 * Tests are not production: a test that passes other values is exactly the sign the generality
 * exists only for them. Scoped like the other typed checks: the change declared the member or the
 * function, or wrote every production host or call.
 */
import type * as TS from 'typescript';
import { isTestFile } from '../test-files.js';
import type { TypedProgram } from './program.js';

export interface DeclaredType { node: TS.InterfaceDeclaration | TS.TypeAliasDeclaration; name: string; members: TS.PropertySignature[] }

export interface ConstantHelpers {
    hostsOf: (t: DeclaredType & { sym: TS.Symbol; type: TS.Type }) => TS.ObjectLiteralExpression[];
    touched: (node: TS.Node) => boolean;
    spanTouched: (node: TS.Node) => boolean;
    at: (node: TS.Node) => string;
    rel: (sf: TS.SourceFile) => string;
    report: (id: string, title: string, node: TS.Node, details: string, hint: string) => void;
    walk: (node: TS.Node, fn: (n: TS.Node) => void) => void;
}

export function constantInputs(typed: TypedProgram, changedSources: TS.SourceFile[], declared: Array<DeclaredType & { sym: TS.Symbol; type: TS.Type }>, h: ConstantHelpers): void {
    constantMembers(typed, declared, h);
    constantArguments(typed, changedSources, h);
}

/** A literal's value as text (`0`, `'a'`, `true`, `null`), or undefined for anything computed. */
function literal(ts: typeof TS, node: TS.Expression | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isNumericLiteral(node) || ts.isStringLiteralLike(node)) return `${ts.isNumericLiteral(node) ? '' : "'"}${node.text}${ts.isNumericLiteral(node) ? '' : "'"}`;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return `-${node.operand.text}`;
    return undefined;
}

/** The access is tested: an `if`/ternary/`while` condition, a comparison, `!`, `&&`/`||`, or a `switch`. */
function inCondition(ts: typeof TS, node: TS.Node): boolean {
    for (let n: TS.Node = node, p = node.parent; p; n = p, p = p.parent) {
        if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isConditionalExpression(p)) && (p as TS.IfStatement).expression === n) return true;
        if (ts.isConditionalExpression(p) && p.condition === n) return true;
        if (ts.isSwitchStatement(p) && p.expression === n) return true;
        if (ts.isBinaryExpression(p) && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) {
            if (ts.isIfStatement(p.parent) || ts.isConditionalExpression(p.parent) || ts.isBinaryExpression(p.parent) || ts.isPrefixUnaryExpression(p.parent) || ts.isReturnStatement(p.parent)) return true;
            continue;
        }
        if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) continue;
        if (ts.isParenthesizedExpression(p)) continue;
        return false;
    }
    return false;
}

function constantMembers(typed: TypedProgram, declared: Array<DeclaredType & { sym: TS.Symbol; type: TS.Type }>, h: ConstantHelpers): void {
    const { ts, checker } = typed;
    for (const t of declared) {
        const hosts = h.hostsOf(t).filter(host => !isTestFile(h.rel(host.getSourceFile())));
        if (hosts.length < 2 || hosts.some(host => host.properties.some(p => ts.isSpreadAssignment(p)))) continue;
        for (const m of t.members) {
            const name = m.name.getText();
            const values = hosts.map(host => {
                const p = host.properties.find(q => q.name && ts.isIdentifier(q.name) && q.name.text === name);
                return p && ts.isPropertyAssignment(p) ? literal(ts, p.initializer) : undefined;
            });
            if (values.some(v => v === undefined) || new Set(values).size !== 1) continue;
            const anchor = h.touched(m) ? m : hosts.every(h.spanTouched) ? hosts.find(h.spanTouched)! : undefined;
            if (!anchor) continue;
            const sym = checker.getPropertyOfType(t.type, name);
            const tested = sym && findReads(typed, sym, h).find(read => inCondition(ts, read));
            if (!tested) continue;
            h.report('constant-member', 'A member every production object sets to the same value', anchor,
                `\`${t.name}.${name}\` is ${values[0]} in all ${hosts.length} production objects of the type (e.g. ${h.at(hosts[0])}), yet ${h.at(tested)} branches on it: the other branches never run outside tests.`,
                `Delete the branches and the member, or pass the real value where the objects are built.`);
        }
    }
}

/** Every non-test read of the property symbol. */
function findReads(typed: TypedProgram, sym: TS.Symbol, h: ConstantHelpers): TS.Node[] {
    const { ts, checker } = typed;
    const decl = sym.declarations?.[0];
    const reads: TS.Node[] = [];
    for (const sf of typed.appSources) {
        if (isTestFile(h.rel(sf)) || !sf.text.includes(sym.name)) continue;
        h.walk(sf, node => {
            if (!ts.isPropertyAccessExpression(node) || node.name.text !== sym.name) return;
            const s = checker.getSymbolAtLocation(node.name);
            if (s && (s === sym || s.declarations?.[0] === decl)) reads.push(node);
        });
    }
    return reads;
}

function constantArguments(typed: TypedProgram, changedSources: TS.SourceFile[], h: ConstantHelpers): void {
    const { ts, checker } = typed;
    // Functions the change declared, by declaration node.
    const functions: Array<TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression> = [];
    for (const sf of changedSources) {
        h.walk(sf, node => {
            if (ts.isFunctionDeclaration(node) && node.name && node.body && node.parameters.length) functions.push(node);
            else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && node.parameters.length) functions.push(node);
        });
    }
    if (functions.length === 0) return;
    const wanted = new Set<TS.Node>(functions);
    const calls = new Map<TS.Node, { prod: TS.CallExpression[]; test: TS.CallExpression[] }>();
    // Tests included: a test passing another value is the evidence a production-only constant is a test seam.
    for (const sf of typed.program.getSourceFiles().filter(f => !f.isDeclarationFile && !f.fileName.includes('/node_modules/'))) {
        const test = isTestFile(h.rel(sf));
        h.walk(sf, node => {
            if (!ts.isCallExpression(node)) return;
            const decl = checker.getResolvedSignature(node)?.declaration;
            if (!decl || !wanted.has(decl)) return;
            const entry = calls.get(decl) ?? { prod: [], test: [] };
            (test ? entry.test : entry.prod).push(node);
            calls.set(decl, entry);
        });
    }
    // A function handed around as a value (a callback, an export others call dynamically) has callers the checker cannot list.
    const passedAsValue = (fn: TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression) => {
        const name = ts.isFunctionDeclaration(fn) ? fn.name : ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined;
        if (!name || !ts.isIdentifier(name)) return true;
        const sym = checker.getSymbolAtLocation(name);
        let escaped = false;
        for (const sf of typed.appSources) {
            if (escaped || !sf.text.includes(name.text)) continue;
            h.walk(sf, node => {
                if (escaped || !ts.isIdentifier(node) || node.text !== name.text || node === name) return;
                if (checker.getSymbolAtLocation(node) !== sym) return;
                const p = node.parent;
                const called = ts.isCallExpression(p) && p.expression === node;
                const imported = ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p);
                if (!called && !imported) escaped = true;
            });
        }
        return escaped;
    };
    for (const fn of functions) {
        const entry = calls.get(fn);
        if (!entry || entry.prod.length < 2 || passedAsValue(fn) || !fn.body) continue;
        fn.parameters.forEach((param, i) => {
            if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return;
            // Literals only: two calls passing a variable of the same name do not pass the same value.
            const texts = entry.prod.map(c => (c.arguments[i] ? literal(ts, c.arguments[i]) : 'undefined'));
            if (texts.some(t => t === undefined) || new Set(texts).size !== 1) return;
            // Proof of dead code: the body branches on the parameter, and production only ever takes one side.
            const paramSym = checker.getSymbolAtLocation(param.name);
            let tested: TS.Node | undefined;
            h.walk(fn.body!, node => {
                if (!tested && ts.isIdentifier(node) && node.text === (param.name as TS.Identifier).text && checker.getSymbolAtLocation(node) === paramSym && inCondition(ts, node)) tested = node;
            });
            if (!tested) return;
            const anchor = h.touched(param) ? param : entry.prod.every(c => h.spanTouched(c)) ? entry.prod[0] : undefined;
            if (!anchor) return;
            const fnName = ts.isFunctionDeclaration(fn) ? fn.name!.text : ((fn.parent as TS.VariableDeclaration).name as TS.Identifier).text;
            h.report('constant-argument', 'A parameter every production call passes the same value', anchor,
                `\`${fnName}\`'s \`${param.name.text}\` is ${texts[0]} in all ${entry.prod.length} production calls (e.g. ${h.at(entry.prod[0])}), yet ${h.at(tested)} branches on it: the other branch never runs outside tests.`,
                `Inline the value and delete the branch, or pass the real value where it is called.`);
        });
    }
}
