import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { forEachNode, symbolOf } from './ast.js';
import { originsOf } from './origins.js';
import { programBatches } from './program.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** Program over `files`; returns the checker and a finder for `probe(<expr>)` arguments in main.ts. */
function setup(files: Record<string, string>) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origins-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    const [program] = [...programBatches([path.join(dir, 'main.ts')], { strict: true, noEmit: true })];
    const checker = program.getTypeChecker();
    const main = program.getSourceFile(path.join(dir, 'main.ts'))!;
    const probe = (): ts.Expression => {
        let found: ts.Expression | undefined;
        forEachNode(main, (n) => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'probe') found = n.arguments[0];
        });
        return found!;
    };
    const kinds = () => originsOf(checker, probe()).map(o =>
        o.kind === 'call' ? `call:${o.node.expression.getText()}` : o.kind === 'param' ? `param:${o.index}` : o.kind);
    return { kinds };
}

const PRELUDE = 'declare function probe(v: unknown): void;\ndeclare function a(): number;\ndeclare function b(): number;\n';

describe('originsOf', () => {
    it('follows const initializers and let reassignments', () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}let x = a();\nif (Math.random()) x = b();\nconst y = x;\nprobe(y);\n` });
        expect(kinds().sort()).toEqual(['call:a', 'call:b']);
    });

    it('maps an element of Promise.all([...]) to the matching call', async () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}async function f() {\n  const [first, second] = await Promise.all([a(), b()]);\n  probe(second);\n  return first;\n}\n` });
        expect(kinds()).toEqual(['call:b']);
    });

    it('reads a destructured property from an object literal', () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}const obj = { left: a(), right: b() };\nconst { right } = obj;\nprobe(right);\n` });
        expect(kinds()).toEqual(['call:b']);
    });

    it('keeps both sides of ?? and of a conditional', () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}const v = Math.random() > 0.5 ? a() : (b() ?? a());\nprobe(v);\n` });
        expect(kinds().sort()).toEqual(['call:a', 'call:a', 'call:b']);
    });

    it('reports a parameter with its index', () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}function f(first: number, second: number) {\n  probe(second);\n  return first;\n}\n` });
        expect(kinds()).toEqual(['param:1']);
    });

    it('follows imports across files to the declaration', () => {
        const { kinds } = setup({
            'lib.ts': 'export const shared = Math.max(1, 2);\n',
            'main.ts': `${PRELUDE}import { shared } from './lib';\nprobe(shared);\n`,
        });
        expect(kinds()).toEqual(['call:Math.max']);
    });

    it('stays unknown for an import that does not resolve', () => {
        const { kinds } = setup({ 'main.ts': `${PRELUDE}import { missing } from './nowhere';\nprobe(missing);\n` });
        expect(kinds()).toEqual(['unknown']);
    });
});

describe('symbolOf', () => {
    it('resolves the name in a shorthand property to the variable it reads', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origins-'));
        fs.writeFileSync(path.join(dir, 'main.ts'), "const headers = { 'x-token': 't' };\nexport const init = { headers };\n");
        const [program] = [...programBatches([path.join(dir, 'main.ts')], { strict: true, noEmit: true })];
        const main = program.getSourceFile(path.join(dir, 'main.ts'))!;
        let shorthand: ts.ShorthandPropertyAssignment | undefined;
        forEachNode(main, (n) => { if (ts.isShorthandPropertyAssignment(n)) shorthand = n; });
        const decl = symbolOf(program.getTypeChecker(), shorthand!.name)?.valueDeclaration;
        expect(decl && ts.isVariableDeclaration(decl) && decl.name.getText()).toBe('headers');
    });
});

