import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportCallSites } from './export.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function sites(code: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-sites-'));
    fs.writeFileSync(path.join(dir, 'main.ts'), code);
    return exportCallSites(dir, ['main.ts']).map(s => [s.function, s.callee, s.ordinal, s.handledBy]);
}

const DECLS = 'declare function a(): Promise<number>;\ndeclare function b(): Promise<number>;\n';

describe('findCallSites', () => {
    it('reports awaited calls and says how each handles failure', () => {
        expect(sites(`${DECLS}
export async function load() {
  const x = await a();
  try { await b(); } catch { return 0; }
  const y = await a().catch(() => 0);
  return x + y;
}`)).toEqual([
            ['load', 'a', 0, null],
            ['load', 'b', 0, 'try'],
            ['load', 'a', 1, 'call'],
        ]);
    });

    it('treats each element of Promise.all as a site, and allSettled as handled', () => {
        expect(sites(`${DECLS}
export async function both() {
  const [x, y] = await Promise.all([a(), b()]);
  const settled = await Promise.allSettled([a()]);
  return [x, y, settled];
}`)).toEqual([
            ['both', 'a', 0, null],
            ['both', 'b', 0, null],
            ['both', 'a', 1, 'all-settled'],
        ]);
    });

    it('counts a callee that catches and returns as handled', () => {
        expect(sites(`${DECLS}
async function safeA() { try { return await a(); } catch { return 0; } }
export async function use() { return await safeA(); }`)).toContainEqual(['use', 'safeA', 0, 'call']);
    });
});
