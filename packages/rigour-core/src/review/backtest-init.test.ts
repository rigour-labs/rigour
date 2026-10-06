import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { ledgerProblems, loadLedger, LEDGER_PATH, LedgerSchema } from './backtest.js';
import { scaffoldLedger } from './backtest-init.js';
import type { Exec } from './reviewer.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const config = ConfigSchema.parse({ version: 1 });

const REVIEWS = [
    { id: 1, user: { login: 'ci-bot', type: 'Bot' }, body: 'automated', state: 'COMMENTED', submitted_at: '2026-04-12T10:00:00Z', commit_id: 'c1c1c1c1c1' },
    { id: 2, user: { login: 'senior', type: 'User' }, body: '## Review\n\n- A retry posts the invoice twice.\n- **Quadratic** scan in `latestPayment`.\nlooks good otherwise', state: 'CHANGES_REQUESTED', submitted_at: '2026-04-12T12:00:00Z', commit_id: 'c2c2c2c2c2' },
];
const INLINE = [
    { path: 'src/lib/server/invoices.ts', line: 40, body: 'The export reads every line item for ids.\n\nNarrow it.', created_at: '2026-04-12T12:00:00Z' },
    { path: 'src/checkout/total.ts', line: null, original_line: null, body: 'Drops the currency', created_at: '2026-04-12T12:00:00Z' },
];

function fakeExec(calls: string[][]): Exec {
    return async (command, args, options) => {
        calls.push([command, ...args]);
        if (command === 'git') return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' };
        if (args[0] === 'auth') return { exitCode: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'pr') return { exitCode: 0, stdout: 'author\n', stderr: '' };
        if (args[1].endsWith('/reviews')) return { exitCode: 0, stdout: JSON.stringify(REVIEWS), stderr: '' };
        return { exitCode: 0, stdout: JSON.stringify(INLINE), stderr: '' };
    };
}

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-init-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'main as of the review'], { env: { ...process.env, GIT_COMMITTER_DATE: '2026-04-12T09:00:00Z', GIT_AUTHOR_DATE: '2026-04-12T09:00:00Z' } });
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('rigour backtest init', () => {
    it('writes one round per human review: inline comments become file-and-window points, body bullets need a pattern', async () => {
        const calls: string[][] = [];
        const mainAtReview = git('rev-parse', 'HEAD');
        const { rounds, incomplete } = await scaffoldLedger(repo, 212, config, fakeExec(calls));
        expect(rounds).toHaveLength(1);
        expect(rounds[0]).toMatchObject({ id: 'pr212-r1', commit: 'c2c2c2c2c2', base: mainAtReview, reviewed_at: '2026-04-12T12:00:00Z', pr: 212 });
        expect(rounds[0].points).toEqual([
            { id: 'R1-1', point: 'The export reads every line item for ids.', file: 'src/lib/server/invoices\\.ts', lines: [30, 50] },
            { id: 'R1-2', point: 'Drops the currency', file: 'src/checkout/total\\.ts', needs: 'a line window or a text pattern (the comment has no line)' },
            { id: 'R1-B1', point: 'A retry posts the invoice twice.', file: '', needs: 'a file pattern and a text pattern (this point was made in the review body, not on a line)' },
            { id: 'R1-B2', point: 'Quadratic scan in latestPayment.', file: '', needs: 'a file pattern and a text pattern (this point was made in the review body, not on a line)' },
        ]);
        expect(incomplete).toBe(3);
        expect(calls.find(c => c[0] === 'gh' && c[1] === 'pr')).toContain('212');
        const written = LedgerSchema.parse(JSON.parse(fs.readFileSync(path.join(repo, LEDGER_PATH), 'utf8')));
        expect(ledgerProblems(written)).toHaveLength(3);
        expect(() => loadLedger(repo)).toThrow('rows a person still has to complete');
    });

    it('keeps rounds already in the ledger and replaces its own', async () => {
        fs.mkdirSync(path.join(repo, '.rigour'));
        fs.writeFileSync(path.join(repo, LEDGER_PATH), JSON.stringify({ rounds: [
            { id: 'pr212-r1', commit: 'old0000', base: 'main', points: [], must_not_flag: [] },
            { id: 'pr7-r1', commit: 'other00', base: 'main', points: [{ id: 'P', point: 'p', file: 'x', text: 'x' }], must_not_flag: [] },
        ] }));
        await scaffoldLedger(repo, 212, config, fakeExec([]));
        const written = LedgerSchema.parse(JSON.parse(fs.readFileSync(path.join(repo, LEDGER_PATH), 'utf8')));
        expect(written.rounds.map(r => [r.id, r.commit])).toEqual([['pr7-r1', 'other00'], ['pr212-r1', 'c2c2c2c2c2']]);
    });
});
