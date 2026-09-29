/**
 * Finds the edit a fix made and proposes rules that would have caught it.
 *
 * Functions are aligned by name path, calls inside them by callee text and
 * order. Two edit shapes are generalised (Getafix-style templates):
 *  - require-option: an argument gains a property (`init` -> `{ ...init, redirect: 'manual' }`);
 *  - require-guard: a property's value gains a condition (`max-age` only when `stepsAvailable`).
 * Each edit yields candidates from most general (callee name) to most
 * specific (this call in this function); validation picks the first that holds.
 */
import ts from 'typescript';
import { forEachNode, isFunctionLike } from '../ast.js';
import { guardsOf, literalPropertyNames, namesIn, propertiesNamed } from './conditions.js';
import {
    calleeDeclarationOf, calleeNameOf, calleeTextOf, functionKeyOf, functionName, invocationArgs, isInvocation, type Invocation,
} from './identity.js';
import type { CalleeMatcher, LearnedPattern } from './types.js';

export interface TreeFile {
    cwd: string;
    checker: ts.TypeChecker;
    sourceFile: ts.SourceFile;
}

export interface ProposedEdit {
    file: string;
    fn: string;
    /** e.g. "deps.fetch(...) gained `redirect`". */
    description: string;
    candidates: LearnedPattern[];
}

export interface Extraction {
    edits: ProposedEdit[];
    /** Changed functions whose edit matches no template. */
    unsupported: string[];
}

export function extractEdits(file: string, before: TreeFile, after: TreeFile): Extraction {
    const beforeFns = functionTexts(before.sourceFile);
    const afterFns = functionTexts(after.sourceFile);
    const changed = [...new Set([...beforeFns.keys(), ...afterFns.keys()])]
        .filter(fn => beforeFns.get(fn) !== afterFns.get(fn));

    const beforeCalls = callsByFunction(before.sourceFile);
    const afterCalls = callsByFunction(after.sourceFile);
    const edits: ProposedEdit[] = [];
    const withEdit = new Set<string>();
    for (const [slot, afterCall] of afterCalls) {
        const beforeCall = beforeCalls.get(slot);
        if (!beforeCall || beforeCall.getText() === afterCall.getText()) continue;
        const fn = functionKeyOf(afterCall);
        const found = [...optionEdits(file, fn, before, beforeCall, afterCall), ...guardEdits(file, fn, before, beforeCall, afterCall)];
        if (found.length > 0) withEdit.add(fn);
        edits.push(...found);
    }
    // A function whose only change is inside a nested function that yielded an edit is covered by it.
    const covered = (fn: string) => [...withEdit].some(key => key === fn || key.startsWith(`${fn}>`));
    return { edits, unsupported: changed.filter(fn => !covered(fn)) };
}

/** Text of each named function, keyed by name path. */
function functionTexts(sf: ts.SourceFile): Map<string, string> {
    const texts = new Map<string, string>();
    forEachNode(sf, (node) => {
        if (isFunctionLike(node) && functionName(node)) texts.set(functionKeyOf(node), node.getText(sf));
    });
    return texts;
}

/** Calls keyed by `<function>|<callee text>|<ordinal>`, so a call pairs with its counterpart. */
function callsByFunction(sf: ts.SourceFile): Map<string, Invocation> {
    const calls = new Map<string, Invocation>();
    const counts = new Map<string, number>();
    forEachNode(sf, (node) => {
        if (!isInvocation(node)) return;
        const base = `${functionKeyOf(node)}|${calleeTextOf(node)}`;
        const ordinal = counts.get(base) ?? 0;
        counts.set(base, ordinal + 1);
        calls.set(`${base}|${ordinal}`, node);
    });
    return calls;
}

function optionEdits(file: string, fn: string, before: TreeFile, beforeCall: Invocation, afterCall: Invocation): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    const afterArgs = invocationArgs(afterCall);
    afterArgs.forEach((arg, argIndex) => {
        const had = new Set(literalPropertyNames(invocationArgs(beforeCall)[argIndex]).map(n => n.toLowerCase()));
        for (const property of literalPropertyNames(arg)) {
            if (had.has(property.toLowerCase())) continue;
            const value = literalValue(arg, property);
            const candidates = calleeLevels(before, beforeCall).map(({ callee, scoped }): LearnedPattern => ({
                template: 'require-option', callee, argIndex, property, ...(value ? { value } : {}), ...(scoped ? { scope: { file, fn } } : {}),
            }));
            edits.push({ file, fn, description: `${calleeTextOf(afterCall)}(...) gained \`${property}\``, candidates });
        }
    });
    return edits;
}

function guardEdits(file: string, fn: string, before: TreeFile, beforeCall: Invocation, afterCall: Invocation): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    const seen = new Map<string, number>();
    for (const afterProp of invocationArgs(afterCall).flatMap(arg => allProperties(arg))) {
        const key = afterProp.name.getText().replace(/^['"`]|['"`]$/g, '');
        const ordinal = seen.get(key.toLowerCase()) ?? 0;
        seen.set(key.toLowerCase(), ordinal + 1);
        const beforeProp = invocationArgs(beforeCall).flatMap(arg => propertiesNamed(arg, key))[ordinal];
        if (!beforeProp) continue;
        const had = new Set(namesIn(guardsOf(beforeProp, beforeCall)));
        const guard = namesIn(guardsOf(afterProp, afterCall)).find(n => !had.has(n));
        if (!guard) continue;
        const candidates = calleeLevels(before, beforeCall).map(({ callee, scoped }): LearnedPattern => ({
            template: 'require-guard', callee, property: key, guard, appliesWhenArgsMention: !scoped, ...(scoped ? { scope: { file, fn } } : {}),
        }));
        edits.push({ file, fn, description: `\`${key}\` in ${calleeTextOf(afterCall)}(...) gained a condition on \`${guard}\``, candidates });
    }
    return edits;
}

/** Callee matchers from most to least general, ending with this exact call in this function. */
function calleeLevels(tree: TreeFile, call: Invocation): Array<{ callee: CalleeMatcher; scoped: boolean }> {
    const levels: Array<{ callee: CalleeMatcher; scoped: boolean }> = [];
    const name = calleeNameOf(call);
    if (name) levels.push({ callee: { level: 'name', key: name }, scoped: false });
    const declaration = calleeDeclarationOf(tree.checker, tree.cwd, call);
    if (declaration) levels.push({ callee: { level: 'declaration', key: declaration }, scoped: false });
    const text = calleeTextOf(call);
    levels.push({ callee: { level: 'text', key: text }, scoped: false });
    levels.push({ callee: { level: 'text', key: text }, scoped: true });
    return levels;
}

function allProperties(root: ts.Node): ts.PropertyAssignment[] {
    const found: ts.PropertyAssignment[] = [];
    forEachNode(root, (node) => { if (ts.isPropertyAssignment(node)) found.push(node); });
    return found;
}

function literalValue(arg: ts.Expression, property: string): string | undefined {
    const prop = propertiesNamed(arg, property)[0];
    return prop && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
}
