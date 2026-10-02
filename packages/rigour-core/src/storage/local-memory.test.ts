import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Failure } from '../types/index.js';

/** An in-memory stand-in for the local SQLite store: records writes, answers the two reads under test. */
const db = vi.hoisted(() => ({
    writes: [] as string[],
    patterns: [] as any[],
    findings: [] as any[],
    reset() { this.writes = []; this.patterns = []; this.findings = []; },
}));

vi.mock('./db.js', () => {
    const store = {
        run: async (sql: string) => { db.writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return { changes: 1, lastID: 0 }; },
        get: async () => undefined,
        all: async (sql: string) => (sql.includes('FROM patterns') ? db.patterns : sql.includes('FROM findings') ? db.findings : []),
        exec: async () => undefined,
        transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(store),
        close: async () => undefined,
    };
    return { openDatabase: async () => store };
});

const { checkLocalPatterns, persistAndReinforce } = await import('./local-memory.js');

let repo: string;
beforeEach(() => {
    db.reset();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-memory-'));
    fs.mkdirSync(path.join(repo, 'src'));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const failure = (id: string, line: number): Failure => ({ id, title: id, details: 'x', severity: 'medium', provenance: 'traditional', files: ['src/a.ts'], line });

describe('persistAndReinforce', () => {
    it('reinforces each category once per scan, however many findings it has', async () => {
        await persistAndReinforce(repo, { status: 'FAIL', failures: [failure('content-check', 1), failure('content-check', 2), failure('content-check', 3), failure('ast', 4)], stats: {} });
        expect(db.writes.filter(w => w.startsWith('INSERT INTO patterns'))).toHaveLength(2);
    });
});

describe('checkLocalPatterns', () => {
    const remembered = (scanTime: number) => ({ file: 'src/a.ts', line: 3, category: 'security', description: 'token logged', confidence: 0.9, scan_time: scanTime });

    it('replays a remembered finding while its file is unchanged since that scan, once', async () => {
        fs.writeFileSync(path.join(repo, 'src/a.ts'), 'log(token)\n');
        const after = fs.statSync(path.join(repo, 'src/a.ts')).mtimeMs + 1000;
        db.patterns = [{ pattern: 'security', strength: 0.9 }];
        db.findings = [remembered(after), remembered(after)];
        const findings = await checkLocalPatterns(repo, ['src/a.ts']);
        expect(findings.map(f => f.description)).toEqual(['[Local Memory] token logged']);
    });

    it('never replays a finding for a file edited since, which may be the fix', async () => {
        fs.writeFileSync(path.join(repo, 'src/a.ts'), 'log(redact(token))\n');
        const before = fs.statSync(path.join(repo, 'src/a.ts')).mtimeMs - 1000;
        db.patterns = [{ pattern: 'security', strength: 0.9 }];
        db.findings = [remembered(before)];
        expect(await checkLocalPatterns(repo, ['src/a.ts'])).toEqual([]);
    });
});
