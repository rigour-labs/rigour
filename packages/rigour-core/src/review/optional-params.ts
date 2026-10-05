/**
 * Optional only for tests: a parameter the change adds as optional (`p?: T`) that every call
 * outside tests passes. Production never takes the "omitted" path, so it is untested where it
 * matters and the type lies about what callers must provide. Calls are found by name in the files
 * that import the function's module (and its own file), read from the syntax tree.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Config, Failure } from '../types/index.js';
import { isTestFile } from './test-files.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const GIT_TIMEOUT_MS = 10_000;

interface OptionalParam {
    file: string;
    fn: string;
    name: string;
    /** The position of the parameter (or of the object parameter holding the property). */
    index: number;
    line: number;
    /** Set for an optional property of an inline object parameter (`opts: { x?: T }`). */
    property?: string;
}

export function optionalParamFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.optional_params?.enabled) return [];
    const failures: Failure[] = [];
    for (const param of addedOptionalParams(cwd, changedLines)) {
        const calls = callsOf(cwd, param);
        const production = calls.filter(c => !isTestFile(c.file));
        const tests = calls.filter(c => isTestFile(c.file));
        if (production.length > 0 && production.every(c => passes(c, param)) && tests.some(c => !passes(c, param))) {
            failures.push(onlyTestsOmit(param, production.length));
        }
    }
    return failures;
}

/** Optional parameters (`p?: T`) on named functions, declared on lines the change added. */
function addedOptionalParams(cwd: string, changedLines: Record<string, Set<number>>): OptionalParam[] {
    const found: OptionalParam[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!CODE.test(file) || isTestFile(file) || lines.size === 0) continue;
        const source = parse(cwd, file);
        if (!source) continue;
        const visit = (node: ts.Node) => {
            const name = functionName(node);
            if (name && ts.isFunctionLike(node)) {
                node.parameters.forEach((p, index) => {
                    const line = source.getLineAndCharacterOfPosition(p.getStart(source)).line + 1;
                    if (p.questionToken && ts.isIdentifier(p.name) && lines.has(line) && !p.dotDotDotToken) found.push({ file, fn: name, name: p.name.text, index, line });
                    if (!p.questionToken && p.type && ts.isTypeLiteralNode(p.type)) {
                        for (const member of p.type.members) {
                            const at = source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1;
                            if (ts.isPropertySignature(member) && member.questionToken && ts.isIdentifier(member.name) && lines.has(at)) {
                                found.push({ file, fn: name, name: member.name.text, index, line: at, property: member.name.text });
                            }
                        }
                    }
                });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return found;
}

function functionName(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    return undefined;
}

interface Call { file: string; args: number; /** For an object argument at the parameter's position: its keys, or null when it cannot be read (a variable, a spread). */ keys?: Set<string> | null }

/** Whether a call provides the parameter, or the property inside the object parameter. Unreadable calls count as providing it. */
function passes(call: Call, param: OptionalParam): boolean {
    if (call.args <= param.index) return false;
    if (!param.property) return true;
    return call.keys === null || call.keys === undefined || call.keys.has(param.property);
}

/** Calls of `param.fn` (`fn(…)` or `x.fn(…)`) in its own file and the files that name it. */
function callsOf(cwd: string, param: OptionalParam): Call[] {
    const grep = spawnSync('git', ['grep', '--untracked', '-l', '-w', '-F', '-e', param.fn], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    const files = grep.status === 0 ? grep.stdout.split('\n').filter(f => f && CODE.test(f)) : [];
    const calls: Call[] = [];
    for (const file of new Set([param.file, ...files])) {
        const source = parse(cwd, file);
        if (!source) continue;
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
                if (name === param.fn) calls.push({ file, args: node.arguments.some(a => ts.isSpreadElement(a)) ? Infinity : node.arguments.length, keys: objectKeys(node.arguments[param.index]) });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return calls;
}

function objectKeys(arg: ts.Expression | undefined): Set<string> | null | undefined {
    if (!arg) return undefined;
    if (!ts.isObjectLiteralExpression(arg) || arg.properties.some(p => ts.isSpreadAssignment(p))) return null;
    return new Set(arg.properties.map(p => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '')).filter(Boolean));
}

function parse(cwd: string, file: string): ts.SourceFile | undefined {
    try {
        return ts.createSourceFile(file, fs.readFileSync(path.join(cwd, file), 'utf8'), ts.ScriptTarget.Latest, true);
    } catch {
        return undefined;
    }
}

function onlyTestsOmit(param: OptionalParam, productionCalls: number): Failure {
    return {
        id: 'optional-for-tests',
        title: 'Optional only for tests',
        details: `\`${param.name}\`${param.property ? ' (an option)' : ''} of \`${param.fn}\` is optional, but all ${productionCalls} call(s) outside tests pass it; only tests omit it.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [param.file],
        line: param.line,
        hint: `Make \`${param.name}\` required and pass it in the tests too, so the type says what callers must provide.`,
    };
}
