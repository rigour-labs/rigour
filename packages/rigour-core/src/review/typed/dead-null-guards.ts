/**
 * dead-null-guard: code that guards a column against null after the query already made it non-null.
 *
 * A query that filters `col` (`.not(col, 'is', null)`, or a range or equality on it, which SQL never
 * matches on NULL) returns rows whose `col` is never null. A guard on `row.col` in code that reads
 * those rows (`?? fallback`, `?.`, `== null`, `!row.col`) can then never fire: dead code that
 * reviewers keep finding round after round, and a row type that keeps telling the next reader
 * otherwise. nullable-filtered-column names the type; this names each guard.
 *
 * Reported only when it is certain: the row type is the one the filtered query returns (`.returns<Row[]>()`
 * or `read…<Row>()`), EVERY query in the program that returns that row type filters the same column,
 * and no object literal builds a row of that type with the column missing or null. A guard is
 * reported on a line the change touched, or anywhere in a file whose filtered query the change touched.
 */
import type * as TS from 'typescript';
import type { TypedProgram } from './program.js';

type Chain = Array<{ call: TS.CallExpression; name: string }>;

export interface GuardHelpers {
    chainOf: (call: TS.CallExpression) => Chain;
    outermost: (call: TS.CallExpression) => boolean;
    rowTypeOf: (chain: Chain, outer: TS.Node) => TS.Type | undefined;
    strArg: (call: TS.CallExpression, i: number) => string | undefined;
    isNullLiteral: (n: TS.Node | undefined) => boolean;
    isNullable: (t: TS.Type) => boolean;
    touched: (node: TS.Node) => boolean;
    at: (node: TS.Node) => string;
    report: (id: string, title: string, node: TS.Node, details: string, hint: string) => void;
    walk: (node: TS.Node, fn: (n: TS.Node) => void) => void;
}

/** Filters SQL never satisfies with NULL: the column of each, as the query names it. */
const NON_NULL_FILTERS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'in', 'like', 'ilike']);

export function deadNullGuards(typed: TypedProgram, changedSources: TS.SourceFile[], h: GuardHelpers): void {
    const { ts, checker } = typed;
    const nonNullColumns = (chain: Chain): Set<string> => {
        const columns = new Set<string>();
        for (const c of chain) {
            const col = h.strArg(c.call, 0);
            if (!col) continue;
            if (c.name === 'not' && h.strArg(c.call, 1) === 'is' && h.isNullLiteral(c.call.arguments[2])) columns.add(col);
            else if (NON_NULL_FILTERS.has(c.name) && !h.isNullLiteral(c.call.arguments[1])) columns.add(col);
        }
        return columns;
    };

    // Every query in the program, by the row type it returns: which columns each guarantees non-null.
    const byRow = new Map<TS.Symbol, Array<{ columns: Set<string>; touched: boolean; file: string; node: TS.Node }>>();
    /**
     * The named row types a query returns: the type itself, or each named member of an intersection
     * (`Row & Record<string, unknown>`). A generic's type parameter and a library type are never a row.
     */
    const rowSymbols = (t: TS.Type | undefined): TS.Symbol[] => {
        if (!t || t.flags & ts.TypeFlags.TypeParameter) return [];
        if (t.isIntersection()) return t.types.flatMap(rowSymbols);
        const sym = t.aliasSymbol ?? t.symbol;
        const decl = sym?.declarations?.[0];
        return sym && decl && !decl.getSourceFile().isDeclarationFile ? [sym] : [];
    };
    for (const sf of typed.appSources) {
        if (!/\.(from|returns)\b|read[A-Z]\w*</.test(sf.text)) continue;
        h.walk(sf, node => {
            if (!ts.isCallExpression(node) || !h.outermost(node)) return;
            const chain = h.chainOf(node);
            if (chain.length === 0 || !startsQuery(chain)) return;
            const columns = nonNullColumns(chain);
            const touched = chain.some(c => h.touched((c.call.expression as TS.PropertyAccessExpression).name));
            for (const sym of rowSymbols(h.rowTypeOf(chain, node))) {
                const list = byRow.get(sym) ?? [];
                list.push({ columns, touched, file: sf.fileName, node: chain[0].call });
                byRow.set(sym, list);
            }
        });
    }

    // A query starts at `.from(…)`/`.select(…)` (or a bare `from(…)`); `query.or(after)` only continues one already counted.
    function startsQuery(chain: Chain): boolean {
        if (chain.some(c => /^(from|select|table|selectFrom)$/.test(c.name))) return true;
        const root = (chain[0].call.expression as TS.PropertyAccessExpression).expression;
        return ts.isCallExpression(root) && ts.isIdentifier(root.expression) && /^(from|select|table)$/.test(root.expression.text);
    }

    for (const [sym, queries] of byRow) {
        if (!sym.declarations?.length) continue;
        const type = checker.getDeclaredTypeOfSymbol(sym);
        for (const prop of checker.getPropertiesOfType(type)) {
            const decl = prop.declarations?.[0];
            if (!decl || !ts.isPropertySignature(decl) || !decl.type) continue;
            const nullable = h.isNullable(checker.getTypeFromTypeNode(decl.type)) || !!decl.questionToken;
            if (!nullable || !queries.every(q => q.columns.has(prop.name))) continue;
            if (builtWithout(typed, sym, prop.name, h)) continue;
            const queryFiles = new Set(queries.filter(q => q.touched).map(q => q.file));
            for (const guard of guardsOn(typed, prop, h)) {
                if (!h.touched(guard.node) && !queryFiles.has(guard.node.getSourceFile().fileName)) continue;
                h.report('dead-null-guard', 'Null guard on a column the query makes non-null', guard.node,
                    `\`${guard.text}\` guards \`${prop.name}\`, but ${queries.length === 1 ? 'the only query' : `all ${queries.length} queries`} returning \`${sym.name}\` (${h.at(queries[0].node)}) filter \`${prop.name}\` non-null, so this branch never runs${guard.emptyString ? ' (it still catches an empty string; compare with \'\' if that case is real)' : ''}.`,
                    `Delete the guard, and narrow \`${sym.name}.${prop.name}\` to its non-null type so the next reader sees the guarantee.`);
            }
        }
    }
}

/** A null guard on the property: `x.p ?? d`, `x.p?.y`, `x.p == null` / `!== null` / `=== undefined`, `!x.p`, `if (x.p)`, `x.p ? a : b`. */
function guardsOn(typed: TypedProgram, prop: TS.Symbol, h: GuardHelpers): Array<{ node: TS.Node; text: string; emptyString: boolean }> {
    const { ts, checker } = typed;
    const found: Array<{ node: TS.Node; text: string; emptyString: boolean }> = [];
    const decl = prop.declarations?.[0];
    const isProp = (access: TS.PropertyAccessExpression) => {
        const s = checker.getSymbolAtLocation(access.name);
        return !!s && (s === prop || s.declarations?.[0] === decl);
    };
    const isNullish = (n: TS.Node) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined');
    for (const sf of typed.appSources) {
        if (!sf.text.includes(prop.name)) continue;
        h.walk(sf, node => {
            if (!ts.isPropertyAccessExpression(node) || node.name.text !== prop.name || !isProp(node)) return;
            const p = node.parent;
            let guard: TS.Node | undefined;
            if (ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) guard = p;
            else if (ts.isPropertyAccessExpression(p) && p.expression === node && p.questionDotToken) guard = p;
            else if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind) && (isNullish(p.left === node ? p.right : p.left))) guard = p;
            else if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) guard = p;
            else if ((ts.isIfStatement(p) && p.expression === node) || (ts.isConditionalExpression(p) && p.condition === node)) guard = node;
            // A number or boolean column is falsy for 0 or false too: a truthiness test there carries meaning beyond null.
            // A string one is falsy only for '' besides null; that is reported, with the '' case named.
            let emptyString = false;
            if (guard && (ts.isPrefixUnaryExpression(p) || guard === node)) {
                const t = checker.getNonNullableType(checker.getTypeAtLocation(node));
                if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike)) guard = undefined;
                else if (t.flags & ts.TypeFlags.StringLike) emptyString = true;
            }
            if (guard) found.push({ node: guard, text: guard.getText().slice(0, 60), emptyString });
        });
    }
    return found;
}

/** An object literal typed as the row that leaves the property out or sets it null: then a null row exists, and the guard is not dead. */
function builtWithout(typed: TypedProgram, sym: TS.Symbol, name: string, h: GuardHelpers): boolean {
    const { ts, checker } = typed;
    let built = false;
    for (const sf of typed.appSources) {
        if (built || !sf.text.includes(sym.name)) continue;
        h.walk(sf, node => {
            if (built || !ts.isObjectLiteralExpression(node)) return;
            const ctx = checker.getContextualType(node);
            // The row type itself, or a type built from it (`Row & Extra`, `Row | Other`).
            const parts = ctx ? [ctx, ...(ctx.isUnionOrIntersection() ? ctx.types : [])] : [];
            if (!parts.some(t => (t.aliasSymbol ?? t.symbol) === sym)) return;
            const member = node.properties.find(p => p.name && ts.isIdentifier(p.name) && p.name.text === name);
            if (node.properties.some(p => ts.isSpreadAssignment(p))) return;
            if (!member || (ts.isPropertyAssignment(member) && member.initializer.kind === ts.SyntaxKind.NullKeyword)) built = true;
        });
    }
    return built;
}
