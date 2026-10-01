import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importsFrom, relatedChanges } from './related-changes.js';
import { rankChangedFunctions } from './risk.js';

let dir: string;
const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
};
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('relatedChanges', () => {
    it('links a changed function to another changed file that imports and calls it, never tests or same-named functions', () => {
        write('src/billing/price.ts', 'export function priceOf(row) {\n  return row.currency;\n}\n');
        write('src/billing/invoice.ts', "import { priceOf } from './price';\n\nexport function invoice(row) {\n  return { cur: 'USD', price: priceOf(row) };\n}\n");
        write('src/billing/price.test.ts', "import { priceOf } from './price';\npriceOf({});\n");
        write('src/other/price.ts', 'export function priceOf(x) {\n  return 1;\n}\n');
        write('src/other/use.ts', "import { priceOf } from './price';\nexport const y = () => priceOf(2);\n");
        const focus = { 'src/billing/price.ts': [2], 'src/billing/invoice.ts': [4], 'src/billing/price.test.ts': [2], 'src/other/use.ts': [2] };
        const links = relatedChanges(dir, Object.keys(focus), rankChangedFunctions(dir, focus));
        expect(links).toEqual([{ callee: 'priceOf', calleeFile: 'src/billing/price.ts', calleeLine: 1, callerFile: 'src/billing/invoice.ts', callerLine: 4 }]);
    });
});

describe('importsFrom', () => {
    it('resolves relative and aliased module paths', () => {
        expect(importsFrom("import { a, b } from '../lib/x';", 'b', 'src/app/y.ts', 'src/lib/x.ts')).toBe(true);
        expect(importsFrom('import { b } from "@/lib/x";', 'b', 'src/app/y.ts', 'src/lib/x.ts')).toBe(true);
        expect(importsFrom("import { bb } from '../lib/x';", 'b', 'src/app/y.ts', 'src/lib/x.ts')).toBe(false);
        expect(importsFrom("import { b } from './x';", 'b', 'src/app/y.ts', 'src/lib/x.ts')).toBe(false);
    });
});
