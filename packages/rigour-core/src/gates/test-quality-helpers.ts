/**
 * Assertion helpers in JavaScript, TypeScript and Python tests: a test that asserts through a helper asserts.
 *
 * A helper is a function the test file imports whose name starts with expect, assert or should
 * (`expectValidOrder`, `assertRedirect`), or a function defined in the test file, or in an in-repo module
 * it imports, whose own body asserts. In Python that includes a base class's method the test calls on
 * `self` (`self.capture_events(expected=0)`), defined in a module the test imports.
 */
import fs from 'fs-extra';
import path from 'path';

const HELPER_NAME = /^(?:expect|assert|should)[A-Z0-9_$]/;
const ASSERTS = /\bexpect\s*[(.]|\bassert\s*[.(]/;
const IMPORT = /import\s+(?:type\s+)?([\w$]+\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

/** Names this test file can call that assert. `read` reads a module once per run (cached by the caller). */
export async function assertionHelpers(cwd: string, file: string, content: string, read: (abs: string) => Promise<string | undefined>): Promise<Set<string>> {
    const helpers = new Set(definedAsserting(content));
    for (const m of content.matchAll(IMPORT)) {
        const names = importedNames(m[1], m[2]);
        for (const [local, exported] of names) if (HELPER_NAME.test(local) || HELPER_NAME.test(exported)) helpers.add(local);
        if (!m[3].startsWith('.')) continue;
        const source = await moduleSource(path.join(cwd, path.dirname(file), m[3]), read);
        if (!source) continue;
        const asserting = new Set(definedAsserting(source));
        for (const [local, exported] of names) if (asserting.has(exported)) helpers.add(local);
    }
    return helpers;
}

/** A call to one of the names on this line; `member` also counts `self.name(` (a Python method). */
export function callsHelper(line: string, helpers: Set<string>, member = false): boolean {
    const before = member ? '(?:^|[^\\w$.]|\\bself\\.)' : '(?:^|[^\\w$.])';
    for (const name of helpers) if (new RegExp(`${before}${name.replace(/\$/g, '\\$')}\\s*[(<]`).test(line)) return true;
    return false;
}

/** `[local, exported]` pairs of an import's default and named bindings. */
function importedNames(defaultName: string | undefined, named: string | undefined): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    const d = defaultName?.replace(/[\s,]/g, '');
    if (d) pairs.push([d, 'default']);
    for (const part of (named ?? '').split(',')) {
        const [exported, local] = part.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/);
        if (exported) pairs.push([(local ?? exported).trim(), exported.trim()]);
    }
    return pairs;
}

async function moduleSource(base: string, read: (abs: string) => Promise<string | undefined>): Promise<string | undefined> {
    // An ESM import names the compiled file (`./helpers.js`); the source is `./helpers.ts`.
    const stems = [...new Set([base, base.replace(/\.[cm]?js$/, '')])];
    for (const stem of stems) for (const ext of EXTENSIONS) {
        const text = await read(stem + ext);
        if (text !== undefined) return text;
    }
    return undefined;
}

/** Functions defined in this source whose body calls expect or assert. */
function definedAsserting(source: string): string[] {
    const names: string[] = [];
    const DEF = /function\s*\*?\s*([\w$]+)\s*[<(]|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/g;
    for (const m of source.matchAll(DEF)) {
        const from = m.index! + m[0].length;
        const body = m[1] || !m[0].endsWith('=>') ? blockAt(source, afterParams(source, m.index!)) : arrowBodyAt(source, from);
        if (ASSERTS.test(body)) names.push(m[1] ?? m[2]);
    }
    return names;
}

/** Just past a function's parameter list (which may hold `{ … }` types or defaults), from its `function` keyword. */
function afterParams(source: string, from: number): number {
    const open = source.indexOf('(', from);
    if (open < 0) return from;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) return i + 1;
    }
    return source.length;
}

/** The first braced block from `from`, braces balanced. */
function blockAt(source: string, from: number): string {
    const open = source.indexOf('{', from);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    return source.slice(open);
}

/** An arrow function's body: a block, else its expression up to the end of the statement. */
function arrowBodyAt(source: string, from: number): string {
    const rest = source.slice(from);
    if (rest.trimStart().startsWith('{')) return blockAt(source, from);
    const end = rest.search(/;|\n\s*\n/);
    return end < 0 ? rest : rest.slice(0, end);
}

const PY_ASSERTS = /\bassert\b|\bself\.assert\w*\s*\(|\braise\s+AssertionError\b|\bpytest\.(?:raises|fail)\b|\.assert_\w+\s*\(/;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^)\n]*)/gm;

/** Python: names this test file can call that assert (see the file comment). */
export async function pythonAssertionHelpers(cwd: string, file: string, content: string, read: (abs: string) => Promise<string | undefined>): Promise<Set<string>> {
    const helpers = new Set(pythonDefinedAsserting(content));
    for (const m of content.matchAll(PY_FROM)) {
        for (const part of m[2].split(',')) {
            const [exported, local] = part.trim().split(/\s+as\s+/);
            if (exported && HELPER_NAME_PY.test(exported)) helpers.add((local ?? exported).trim());
        }
        const source = await pythonModule(cwd, file, m[1], read);
        for (const name of source ? pythonDefinedAsserting(source) : []) helpers.add(name);
    }
    return helpers;
}

const HELPER_NAME_PY = /^(?:expect|assert|should)_?\w/;

async function pythonModule(cwd: string, file: string, module: string, read: (abs: string) => Promise<string | undefined>): Promise<string | undefined> {
    const dots = module.match(/^\.*/)![0].length;
    const parts = module.slice(dots).split('.').filter(Boolean);
    let base = cwd;
    if (dots) {
        base = path.join(cwd, path.dirname(file));
        for (let i = 1; i < dots; i++) base = path.dirname(base);
    }
    const stem = path.join(base, ...parts);
    return await read(`${stem}.py`) ?? await read(path.join(stem, '__init__.py'));
}

/** Python functions and methods in this source whose body asserts. */
function pythonDefinedAsserting(source: string): string[] {
    const names: string[] = [];
    const lines = source.split('\n');
    lines.forEach((line, i) => {
        const def = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
        if (!def || def[2].startsWith('test_')) return;
        for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j];
            if (next.trim() && next.search(/\S/) <= def[1].length && !/^\s*[)\]]/.test(next)) break;
            if (PY_ASSERTS.test(next)) { names.push(def[2]); break; }
        }
    });
    return names;
}
