/**
 * What a change made redundant, found with the TypeScript checker instead of a model's attention.
 * Four blocking classes, the dead code a person kept finding after every other gate was green:
 *   duplicate-null-filter     `.not(col, 'is', null)` in a query chain that already ranges or
 *                             equals on `col` (SQL excludes NULL there);
 *   nullable-filtered-column  the query filters `col` non-null, the row type still says `| null`,
 *                             so every guard on it is dead;
 *   optional-always-supplied  an optional property every host object supplies (unless values of the type are
 *                             also read back from JSON, where data written before the member existed lacks it);
 *   write-only-property       a property the hosts set and nothing reads. When the value only
 *                             leaves through serialisation to a callee the program does not declare
 *                             (a wire payload), that is a hint for the reviewer, not a block.
 * Plus dead-null-guard (dead-null-guards.ts): a null guard on a column every query returning the row filters;
 * constant-member and constant-argument (constant-inputs.ts): an input production never varies.
 * Plus a note, not yet proven on merged pull requests so it never blocks:
 *   nullable-not-null-column  the row type of `.from('t')` says `| null` for a column the
 *                             migrations make NOT NULL (`schema_migrations`, schema-nullability.ts).
 * Plus a hint: a function that scans a collection, called once per item of another (nested-scan).
 * Scoped to lines the change touched and members it declared, or whose every host it wrote; a
 * pre-existing member with one touched writer is the team's backlog, not this change's.
 */
import micromatch from 'micromatch';
import type * as TS from 'typescript';
import type { Config, Failure } from '../../types/index.js';
import { emitsDeclarations } from '../package-layout.js';
import { isTestFile } from '../test-files.js';
import { loadProgram, type TextFile, type TypedProgram } from './program.js';
import { loadSchemaNullability, tableKey, type SchemaNullability } from './schema-nullability.js';
import { deadNullGuards } from './dead-null-guards.js';
import { constantInputs } from './constant-inputs.js';

export interface Redundancy {
    failures: Failure[];
    hints: string[];
    /** A TypeScript project whose program cannot be built: the checks could not run, which is never a pass (review.ts turns it into a gate error). */
    error?: string;
}

export const TYPED_CHECKS = 'typed-checks-unavailable';

/** The typed checks on a change: nothing when it touches no TypeScript or the project has no tsconfig. */
export function typedChecks(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Redundancy {
    if (!config.gates.redundancy?.enabled || !Object.keys(changedLines).some(file => /\.[cm]?ts$/.test(file) && !isTestFile(file))) return { failures: [], hints: [] };
    const loaded = loadProgram(cwd);
    if ('skip' in loaded) return { failures: [], hints: [] };
    if ('error' in loaded) return { failures: [], hints: [], error: `${loaded.error} (install the dependencies, and run the framework's sync if it has one)` };
    return redundancyFailures(loaded.program, changedLines, config);
}

const RANGE = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'in', 'like', 'ilike']);
const MENTION_DEPTH = 3;

function redundancyFailures(typed: TypedProgram, changedLines: Record<string, Set<number>>, config: Config): Redundancy {
    const settings = config.gates.redundancy;
    if (!settings?.enabled) return { failures: [], hints: [] };
    const { ts, checker, rel } = typed;
    const changed = Object.keys(changedLines).filter(file => /\.[cm]?ts$/.test(file) && !file.endsWith('.d.ts') && !isTestFile(file));
    const failures: Failure[] = [];
    const hints: string[] = [];
    const line = (node: TS.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const at = (node: TS.Node) => `${rel(node.getSourceFile())}:${line(node)}`;
    const touched = (node: TS.Node) => !!changedLines[rel(node.getSourceFile())]?.has(line(node));
    const spanTouched = (node: TS.Node) => {
        const set = changedLines[rel(node.getSourceFile())];
        if (!set) return false;
        const sf = node.getSourceFile();
        for (let l = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1; l <= sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1; l++) if (set.has(l)) return true;
        return false;
    };
    const report = (id: string, title: string, node: TS.Node, details: string, hint: string) =>
        failures.push({ id, title, details, hint, severity: 'medium', provenance: 'traditional', files: [rel(node.getSourceFile())], line: line(node) });
    const walk = (node: TS.Node, fn: (n: TS.Node) => void) => {
        fn(node);
        ts.forEachChild(node, child => walk(child, fn));
    };
    const strArg = (call: TS.CallExpression, i: number) => call.arguments[i] && ts.isStringLiteralLike(call.arguments[i]) ? (call.arguments[i] as TS.StringLiteralLike).text : undefined;
    const isNullLiteral = (n: TS.Node | undefined) => !!n && n.kind === ts.SyntaxKind.NullKeyword;
    const changedSources = changed.map(file => typed.program.getSourceFile(`${typed.root}/${file}`)).filter((sf): sf is TS.SourceFile => !!sf);

    // A method chain `a.b(...).c(...)` as its calls, outermost last.
    const chainOf = (call: TS.CallExpression) => {
        const calls: Array<{ call: TS.CallExpression; name: string }> = [];
        let n: TS.Expression = call;
        while (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            calls.unshift({ call: n, name: n.expression.name.text });
            n = n.expression.expression;
        }
        return calls;
    };
    const outermost = (call: TS.CallExpression) => !(ts.isPropertyAccessExpression(call.parent) && ts.isCallExpression(call.parent.parent) && call.parent.parent.expression === call.parent);
    const elementType = (t: TS.Type) => checker.isArrayType(t) ? checker.getTypeArguments(t as TS.TypeReference)[0] : (t.getNumberIndexType() ?? t);
    /** The row type a chain returns: `.returns<Row[]>()`, else the type argument of an enclosing `read…<Row>()` call. */
    const rowTypeOf = (chain: ReturnType<typeof chainOf>, outer: TS.Node): TS.Type | undefined => {
        const ret = chain.find(c => c.name === 'returns' && c.call.typeArguments?.length);
        if (ret) return elementType(checker.getTypeFromTypeNode(ret.call.typeArguments![0]));
        for (let n = outer.parent; n; n = n.parent) {
            if (ts.isCallExpression(n) && n.typeArguments?.length && ts.isIdentifier(n.expression) && /^read[A-Z]\w*$/.test(n.expression.text)) return checker.getTypeFromTypeNode(n.typeArguments[0]);
        }
        return undefined;
    };
    const isNullable = (t: TS.Type) => t.isUnion() && t.types.some(m => !!(m.flags & ts.TypeFlags.Null));

    // nullable-not-null-column: read once, and only when a changed file queries a table.
    let schema: SchemaNullability | undefined;
    const reportedDecls = new Set<TS.Node>();
    const notNullColumns = (chain: ReturnType<typeof chainOf>, outer: TS.Node, filtered: Set<string>) => {
        const from = chain.find(c => c.name === 'from' && strArg(c.call, 0));
        if (!from) return;
        const schemaCall = chain.find(c => c.name === 'schema' && strArg(c.call, 0));
        const table = `${schemaCall ? `${strArg(schemaCall.call, 0)}.` : ''}${strArg(from.call, 0)}`;
        schema ??= loadSchemaNullability(typed.root, settings.schema_migrations);
        const columns = schema.get(tableKey(table));
        const row = columns && rowTypeOf(chain, outer);
        if (!columns || !row) return;
        const select = chain.find(c => c.name === 'select');
        const selected = select ? strArg(select.call, 0) ?? '' : '';
        // The query's own line the change touched: a call's start is the start of the whole chain, so its method name.
        const queryLine = chain.map(c => (c.call.expression as TS.PropertyAccessExpression).name).find(touched);
        for (const prop of checker.getPropertiesOfType(row)) {
            const decl = prop.declarations?.[0];
            const name = prop.name;
            if (!decl || !ts.isPropertySignature(decl) || !decl.type || reportedDecls.has(decl) || filtered.has(name)) continue;
            // An alias (`name:other_column`) maps another column onto this property.
            if (columns.get(name) !== true || new RegExp(`(^|[\\s,(])${name.replace(/[$]/g, '\\$')}\\s*:`).test(selected) || !isNullable(checker.getTypeFromTypeNode(decl.type))) continue;
            const anchor = touched(decl) ? decl : queryLine;
            if (!anchor) continue;
            reportedDecls.add(decl);
            report('nullable-not-null-column', 'Nullable type for a NOT NULL column', anchor,
                `\`${name}\` is declared nullable at ${at(decl)} but \`${table}.${name}\` is NOT NULL in the migrations, so every guard on it is dead.`,
                'Narrow the row type and delete the guards on it. If the migrations Rigour read are not the ones this code runs against, point gates.redundancy.schema_migrations at them.');
        }
    };

    // duplicate-null-filter, nullable-filtered-column and nullable-not-null-column
    for (const sf of changedSources) {
        walk(sf, node => {
            if (!ts.isCallExpression(node) || !outermost(node)) return;
            const chain = chainOf(node);
            const nots = chain.filter(c => c.name === 'not' && strArg(c.call, 1) === 'is' && isNullLiteral(c.call.arguments[2]) && strArg(c.call, 0));
            notNullColumns(chain, node, new Set(nots.map(n => strArg(n.call, 0)!)));
            if (nots.length === 0 || !spanTouched(node)) return;
            for (const n of nots) {
                const col = strArg(n.call, 0)!;
                const range = chain.find(c => RANGE.has(c.name) && strArg(c.call, 0) === col);
                if (range) {
                    report('duplicate-null-filter', 'Redundant null filter', n.call,
                        `\`.not('${col}', 'is', null)\` is redundant next to \`.${range.name}('${col}', …)\` at ${at(range.call)}: SQL already excludes NULL there.`,
                        'Delete the null filter.');
                }
                const row = rowTypeOf(chain, node);
                const prop = row && checker.getPropertyOfType(row, col);
                const decl = prop?.declarations?.[0];
                if (decl && ts.isPropertySignature(decl) && decl.type && isNullable(checker.getTypeFromTypeNode(decl.type))) {
                    // Anchored on the query the change wrote; the declaration may be in a file it did not touch.
                    report('nullable-filtered-column', 'Nullable type for a column the query filters non-null', n.call,
                        `\`${col}\` is declared nullable at ${at(decl)} but this query filters it non-null, so every guard on it is dead.`,
                        'Narrow the row type and delete the guards on it.');
                }
            }
        });
    }

    deadNullGuards(typed, changedSources, { chainOf, outermost, rowTypeOf, strArg, isNullLiteral, isNullable, touched, at, report, walk });

    // Interfaces and type literals declared in changed files, with their properties.
    interface Declared { node: TS.InterfaceDeclaration | TS.TypeAliasDeclaration; name: string; sym: TS.Symbol; type: TS.Type; members: TS.PropertySignature[] }
    const declaredTypes: Declared[] = [];
    for (const sf of changedSources) {
        walk(sf, node => {
            if (!(ts.isInterfaceDeclaration(node) || (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)))) return;
            const sym = checker.getSymbolAtLocation(node.name);
            if (!sym) return;
            const members = (ts.isInterfaceDeclaration(node) ? node.members : (node.type as TS.TypeLiteralNode).members).filter((m): m is TS.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name));
            declaredTypes.push({ node, name: node.name.text, sym, type: checker.getDeclaredTypeOfSymbol(sym), members });
        });
    }

    // Does a type carry T: itself, an array of it, a union or intersection member, or a property a few levels down.
    const mentionMemo = new Map<string, boolean>();
    const mentionsType = (t: Declared, ty: TS.Type | undefined, depth = 0): boolean => {
        if (!ty || depth > MENTION_DEPTH) return false;
        if (ty.symbol === t.sym || ty.aliasSymbol === t.sym) return true;
        if (ty.aliasTypeArguments?.some(a => mentionsType(t, a, depth + 1))) return true;
        const key = `${t.sym.escapedName as string}|${(ty as any).id}`;
        if (mentionMemo.has(key)) return mentionMemo.get(key)!;
        mentionMemo.set(key, false);
        let hit = false;
        if (checker.isArrayType(ty)) hit = mentionsType(t, checker.getTypeArguments(ty as TS.TypeReference)[0], depth + 1);
        else if (ty.isUnionOrIntersection()) hit = ty.types.some(m => mentionsType(t, m, depth + 1));
        else if (ty.flags & ts.TypeFlags.Object && !(ty.symbol && ty.symbol.flags & ts.SymbolFlags.Function)) hit = checker.getPropertiesOfType(ty).some(p => mentionsType(t, checker.getTypeOfSymbol(p), depth + 1));
        mentionMemo.set(key, hit);
        return hit;
    };

    // Object literals the checker types as T, in non-test files that mention T by name.
    const hostsOf = (t: Declared): TS.ObjectLiteralExpression[] => {
        const hosts: TS.ObjectLiteralExpression[] = [];
        const mentions = (ty: TS.Type): boolean => ty.symbol === t.sym || ty.aliasSymbol === t.sym || (ty.isUnionOrIntersection() && ty.types.some(mentions));
        for (const sf of typed.appSources) {
            if (!sf.text.includes(t.name)) continue;
            walk(sf, node => {
                if (!ts.isObjectLiteralExpression(node)) return;
                const ctx = checker.getContextualType(node);
                if (ctx && mentions(ctx)) hosts.push(node);
            });
        }
        return hosts;
    };
    const literalHas = (lit: TS.ObjectLiteralExpression, name: string) => lit.properties.some(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && !!p.name && ts.isIdentifier(p.name) && p.name.text === name);
    const literalSpreads = (lit: TS.ObjectLiteralExpression) => lit.properties.some(p => ts.isSpreadAssignment(p));
    const word = (s: string) => new RegExp(`\\b${s.replace(/[$]/g, '\\$')}\\b`);
    // An untyped file is a host when it names the type and visibly supplies a required member (a consumer only reads them).
    const supplyRe = (key: string) => new RegExp(`(?<![.\\w])${key}\\s*:|(?<![.\\w])${key}\\s*\\([^()]*\\)\\s*\\{|[{,]\\s*${key}\\s*[,}]`);
    const textHosts = (t: Declared): TextFile[] => {
        const required = t.members.filter(m => !m.questionToken).map(m => m.name.getText());
        const keys = required.length ? required : t.members.map(m => m.name.getText());
        return typed.textFiles.filter(s => word(t.name).test(s.text) && keys.some(k => supplyRe(k).test(s.text)));
    };
    // A read in an untyped file counts only where that file names the type or imports its module.
    const textReads = (t: Declared, prop: string): TextFile | undefined => {
        const stem = rel(t.node.getSourceFile()).replace(/\.[cm]?ts$/, '');
        return typed.textFiles.find(s => (word(t.name).test(s.text) || s.text.includes(stem) || s.text.includes(stem.replace(/^src\/lib\//, '$lib/'))) && new RegExp(`\\.${prop}\\b|\\{[^}]*\\b${prop}\\b[^}]*\\}`).test(s.text));
    };

    constantInputs(typed, changedSources, declaredTypes, { hostsOf, touched, spanTouched, at, rel, report, walk });

    // A value of the type that leaves the program's sight: placed in a string, or passed to a callee the program does not declare.
    const escapeMemo = new Map<TS.Symbol, string | undefined>();
    const escapes = (t: Declared): string | undefined => {
        if (escapeMemo.has(t.sym)) return escapeMemo.get(t.sym);
        let found: string | undefined;
        for (const sf of typed.appSources) {
            if (found) break;
            walk(sf, node => {
                if (found || !ts.isExpression(node) || !node.parent) return;
                const p = node.parent;
                const isArg = ts.isCallExpression(p) && p.arguments.includes(node);
                const stringified = ts.isTemplateSpan(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken);
                if (!isArg && !stringified) return;
                const ty = (ts.isObjectLiteralExpression(node) && checker.getContextualType(node)) || checker.getTypeAtLocation(node);
                if (!mentionsType(t, ty)) return;
                if (stringified) {
                    found = `string building at ${at(node)}`;
                    return;
                }
                const call = p as TS.CallExpression;
                const sig = checker.getResolvedSignature(call);
                const decl = sig?.declaration;
                // Storing into a collection (events.push(e), map.set(k, v)) keeps the value typed and visible.
                if (decl?.getSourceFile().isDeclarationFile && ts.isPropertyAccessExpression(call.expression)) {
                    const holder = checker.getTypeAtLocation(call.expression.expression);
                    const holderName = String(holder.symbol?.escapedName ?? holder.aliasSymbol?.escapedName ?? '');
                    if (checker.isArrayType(holder) || /^(Map|Set|WeakMap|WeakSet|Promise|ReadonlyMap|ReadonlySet)$/.test(holderName)) return;
                }
                const param = sig?.parameters[call.arguments.indexOf(node as TS.Expression)];
                const paramType = param && checker.getTypeOfSymbolAtLocation(param, call);
                if (!decl || !typed.inProgram.has(rel(decl.getSourceFile())) || !mentionsType(t, paramType)) found = `${call.expression.getText().slice(0, 40)}() at ${at(node)}`;
            });
        }
        escapeMemo.set(t.sym, found);
        return found;
    };

    // Where a value of T is put in a place declared as another type (a property typed as a same-shape inline type, a
    // variable, a parameter, a return), T's members travel as that type: the declared types the place names.
    const isFlowSite = (node: TS.Node) => {
        const p = node.parent;
        return !!p && ((ts.isPropertyAssignment(p) && p.initializer === node) || ts.isSpreadAssignment(p) || (ts.isVariableDeclaration(p) && p.initializer === node)
            || ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === node) || (ts.isCallExpression(p) && p.arguments.includes(node as TS.Expression)));
    };
    // The declared types a place names. A property or spread in an object literal whose own declared type names none
    // (an inline type) is carried by the literal: the declared types of the place the literal goes, a level up at a time.
    const namedAt = (node: TS.Node, t: Declared): Declared[] => {
        for (let at: TS.Node | undefined = node; at && ts.isExpression(at); at = ts.isObjectLiteralExpression(at.parent?.parent) ? at.parent.parent : undefined) {
            const target = checker.getContextualType(at as TS.Expression);
            if (!target || target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || mentionsType(t, target)) return [];
            const named = declaredTypes.filter(d => d.sym !== t.sym && mentionsType(d, target));
            if (named.length) return named;
        }
        return [];
    };
    const flowMemo = new Map<TS.Symbol, Declared[]>();
    const flowsInto = (t: Declared): Declared[] => {
        const cached = flowMemo.get(t.sym);
        if (cached) return cached;
        const into = new Set<Declared>();
        for (const sf of typed.appSources) {
            walk(sf, node => {
                if (!ts.isExpression(node) || !isFlowSite(node) || !mentionsType(t, checker.getTypeAtLocation(node))) return;
                for (const d of namedAt(node, t)) into.add(d);
            });
        }
        const found = [...into];
        flowMemo.set(t.sym, found);
        return found;
    };
    // T leaves the program where its own values do, or where a type it travels as does.
    const leaves = (t: Declared, seen = new Set<TS.Symbol>([t.sym])): string | undefined => {
        const direct = escapes(t);
        if (direct) return direct;
        for (const d of flowsInto(t)) {
            if (seen.has(d.sym)) continue;
            seen.add(d.sym);
            const via = leaves(d, seen);
            if (via) return `${via}, carried as ${d.name}`;
        }
        return undefined;
    };

    // Values of the type read back from JSON (JSON.parse, readJson, a response's .json()) as the type: an assertion,
    // an annotated variable, a type argument, or the declared return of the function that returns them. Data written
    // before a member existed lacks it, so the member stays optional however every host in the code supplies it now.
    const holdsType = (t: Declared, ty: TS.Type | undefined): boolean => {
        if (!ty) return false;
        const awaited = checker.getAwaitedType(ty) ?? ty;
        return mentionsType(t, awaited) || checker.getIndexInfosOfType(awaited).some(info => mentionsType(t, info.type));
    };
    const JSON_READ = /(?:^|\.)(?:JSON\.parse|readJson|readJsonSync|json)$/;
    const persistedMemo = new Map<TS.Symbol, string | undefined>();
    const readFromJson = (t: Declared): string | undefined => {
        if (persistedMemo.has(t.sym)) return persistedMemo.get(t.sym);
        let found: string | undefined;
        for (const sf of typed.appSources) {
            if (found) break;
            if (!/JSON\.parse|readJson|\.json\(/.test(sf.text)) continue;
            walk(sf, node => {
                if (found || !ts.isCallExpression(node) || !JSON_READ.test(node.expression.getText())) return;
                if (node.typeArguments?.some(a => holdsType(t, checker.getTypeFromTypeNode(a)))) { found = at(node); return; }
                let site: TS.Node = node;
                while (ts.isParenthesizedExpression(site.parent) || ts.isAwaitExpression(site.parent) || ts.isNonNullExpression(site.parent)) site = site.parent;
                const p = site.parent;
                const target = ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p) ? p.type
                    : ts.isVariableDeclaration(p) && p.initializer === site ? p.type
                    : undefined;
                if (target && holdsType(t, checker.getTypeFromTypeNode(target))) { found = at(node); return; }
                const fn = ts.isReturnStatement(p) ? ts.findAncestor(p, ts.isFunctionLike) : ts.isArrowFunction(p) && p.body === site ? p : undefined;
                const signature = fn && checker.getSignatureFromDeclaration(fn as TS.SignatureDeclaration);
                if (fn?.type && signature && holdsType(t, checker.getReturnTypeOfSignature(signature))) found = at(node);
            });
        }
        persistedMemo.set(t.sym, found);
        return found;
    };

    // A property is read when any non-test file accesses or destructures it; a spread only passes it on.
    const isWriteTarget = (access: TS.PropertyAccessExpression) => ts.isBinaryExpression(access.parent) && access.parent.left === access && access.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const isRead = (t: Declared, name: string): string | undefined => {
        const sym = checker.getPropertyOfType(t.type, name);
        if (!sym) return 'no such property';
        const declaration = sym.declarations?.[0];
        const isOurs = (s: TS.Symbol | undefined) => !!s && (s === sym || !!s.declarations?.some(d => d === declaration));
        const ofType = (expr: TS.Node) => mentionsType(t, checker.getTypeAtLocation(expr));
        for (const sf of typed.appSources) {
            if (!sf.text.includes(name) && !sf.text.includes('...')) continue;
            let read: TS.Node | undefined;
            walk(sf, node => {
                if (read) return;
                if (ts.isPropertyAccessExpression(node) && node.name.text === name && !isWriteTarget(node) && isOurs(checker.getSymbolAtLocation(node.name))) read = node;
                else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ((node.propertyName && ts.isIdentifier(node.propertyName) && node.propertyName.text === name) || (!node.propertyName && ts.isIdentifier(node.name) && node.name.text === name)) && ofType(node.parent)) read = node;
                else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === name && ofType(node.expression)) read = node;
            });
            if (read) return at(read);
        }
        const text = textReads(t, name);
        return text ? `${text.file} (by name)` : undefined;
    };

    for (const t of declaredTypes) {
        const hosts = hostsOf(t);
        if (hosts.length === 0 && !t.members.some(m => m.questionToken)) continue;
        // A declared wire contract (a payload another service reads) is read by that service: its members are never write-only here.
        const wire = micromatch.isMatch(rel(t.node.getSourceFile()), settings.wire_contracts);
        // In a library (declarations emitted), an exported type is read by consumers outside this program: what looks
        // write-only or always-supplied here is a hint for the reviewer, not a block.
        const published = !!t.node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && emitsDeclarations(typed.root, rel(t.node.getSourceFile()));
        const publish = (id: string, node: TS.Node, text: string) => hints.push(`${id} ${at(node)}: ${text} (an exported type of a library: consumers outside this program may read it)`);
        for (const m of t.members) {
            const name = m.name.getText();
            const supplied = hosts.filter(h => literalHas(h, name));
            const spreads = hosts.some(literalSpreads);
            // The change owns the finding when it declared the member or wrote every host; it is anchored on
            // a line the change touched (the member, else a host it wrote) and names the other place.
            const anchor = touched(m) ? m : hosts.length && hosts.every(spanTouched) ? hosts.find(spanTouched)! : undefined;
            if (!anchor) continue;
            const member = `\`${t.name}.${name}\`${anchor === m ? '' : ` (${at(m)})`}`;
            if (m.questionToken && !spreads) {
                const outside = textHosts(t);
                const all = hosts.length + outside.length;
                if (all > 0 && supplied.length === hosts.length && outside.every(s => supplyRe(name).test(s.text))) {
                    const text = `${member} is optional but every host supplies it (${all} host(s), e.g. ${hosts[0] ? at(hosts[0]) : outside[0].file}).`;
                    const stored = readFromJson(t);
                    if (stored) hints.push(`optional-always-supplied ${at(m)}: ${text} Values of it are read back from JSON at ${stored}, where data written before the member existed lacks it: keep it optional unless that data is migrated`);
                    else if (published) publish('optional-always-supplied', m, text);
                    else report('optional-always-supplied', 'Optional member every host supplies', anchor, text, 'Make it required and drop the `?.` and the fallbacks on it.');
                }
            }
            if (supplied.length && !wire && !isRead(t, name)) {
                const exit = leaves(t);
                if (exit) hints.push(`write-only-property ${at(m)}: ${t.name}.${name} is set by ${supplied.length} host(s) and read by no code; the value leaves only through ${exit}. Confirm an external reader needs it, else delete it`);
                else if (published) publish('write-only-property', m, `${member} is set by ${supplied.length} host(s) and read nowhere in this program`);
                else {
                    report('write-only-property', 'Property written and never read', anchor,
                        `${member} is set by ${supplied.length} host(s) (e.g. ${at(supplied[0])}) and read nowhere outside tests.`,
                        'Delete it, or name the reader. If another service reads this type, list its file under gates.redundancy.wire_contracts.');
                }
            }
        }
    }

    // Hint: a function with a collection parameter that scans it, called inside a loop or an array callback over another collection.
    for (const sf of changedSources) {
        const scanners = new Map<string, string>();
        walk(sf, node => {
            if (!(ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || !node.body) return;
            const name = ts.isFunctionDeclaration(node) ? node.name?.text : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
            if (!name) return;
            const collections = node.parameters.filter(p => ts.isIdentifier(p.name) && p.type && (ts.isArrayTypeNode(p.type) || (ts.isTypeOperatorNode(p.type) && ts.isArrayTypeNode(p.type.type)) || (ts.isTypeReferenceNode(p.type) && /^(Array|ReadonlyArray|Map|Set|Iterable)$/.test(p.type.typeName.getText())))).map(p => (p.name as TS.Identifier).text);
            if (collections.length === 0) return;
            let scans: string | undefined;
            walk(node.body, n => {
                if (scans) return;
                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(find|filter|some|every|findIndex|includes|indexOf)$/.test(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && collections.includes(n.expression.expression.text)) scans = n.expression.expression.text;
                if (ts.isForOfStatement(n) && ts.isIdentifier(n.expression) && collections.includes(n.expression.text)) scans = n.expression.text;
            });
            if (scans) scanners.set(name, scans);
        });
        if (scanners.size === 0) continue;
        const inLoop = (n: TS.Node): string | undefined => {
            for (let p = n.parent; p; p = p.parent) {
                if (ts.isForOfStatement(p) || ts.isForStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p)) return 'a loop';
                if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && /^(map|flatMap|filter|forEach|some|every|find|reduce)$/.test(p.parent.expression.name.text)) return `.${p.parent.expression.name.text}() over ${p.parent.expression.expression.getText().slice(0, 40)}`;
                if (ts.isFunctionDeclaration(p)) return undefined;
            }
            return undefined;
        };
        walk(sf, node => {
            if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !scanners.has(node.expression.text)) return;
            const loop = inLoop(node);
            if (loop) hints.push(`nested-scan ${at(node)}: ${node.expression.text}() scans its \`${scanners.get(node.expression.text)}\` argument and is called inside ${loop}; confirm the sizes or index the inner collection once`);
        });
    }
    return { failures, hints };
}
