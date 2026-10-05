import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFunction } from '../deep/risk.js';
import { diffFromGit } from './git-diff.js';
import { recordReview } from './ledger.js';
import { buildQualityReceipt } from './receipt.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
const review = (file: string, fn: string, reviewer = 'agent') => {
    const found = findFunction(repo, file, fn)!;
    recordReview(repo, { file, function: fn, hash: found.hash, reviewer, verdict: 'no_issue', note: 'checked' });
};

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('.gitignore', '.rigour/\n');
    write('src/pay.ts', 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

// Risky: a data write. Low risk: a formatter. Each in its own function.
const RISKY = (n: number) => `export async function saveRefund${n}(db: any, cents: number) {\n  return db.insert({ cents: cents + ${n} });\n}\n`;
const PLAIN = 'export function label(name: string) {\n  return name.trim();\n}\n';

describe('buildQualityReceipt', () => {
    it('says what was reviewed at its current code, what changed after review, what is low risk, and what is not covered', () => {
        write('src/pay.ts', RISKY(1) + RISKY(2) + RISKY(3) + PLAIN);
        write('config/app.yml', 'a: 1\n');
        review('src/pay.ts', 'saveRefund1');
        review('src/pay.ts', 'saveRefund2');
        write('src/pay.ts', RISKY(1) + RISKY(2).replace('cents + 2', 'cents + 20') + RISKY(3) + PLAIN); // edited after its review

        const receipt = buildQualityReceipt(repo, diffFromGit(repo));
        expect(receipt).toMatchObject({ functions: 4, reviewed: 1, changedSinceReview: 1, lowRisk: 1, otherFiles: 1, setAside: 0, reviewers: { agent: 1 } });
        expect(receipt.notCovered.map(g => [g.function, g.changedSinceReview])).toEqual([['saveRefund2', true], ['saveRefund3', false]]);
    });

    it('counts no self-reported review when independent, and says how many it set aside', () => {
        write('src/pay.ts', RISKY(1) + RISKY(2));
        review('src/pay.ts', 'saveRefund1');
        const receipt = buildQualityReceipt(repo, diffFromGit(repo), { independent: true });
        expect(receipt).toMatchObject({ reviewed: 0, setAside: 1 });
        expect(receipt.notCovered).toHaveLength(2);
    });

    it('treats a function matching a verified team lesson as risky, and says which lesson', () => {
        write('src/pay.ts', 'export function formatTotal(totalCents: number) {\n  return (totalCents / 100).toFixed(2);\n}\n');
        write('.rigour/review-lessons.json', JSON.stringify({ version: 1, lessons: [{
            id: 'l1', text: 'Format money from integer cents, never floats.', file: 'src/pay.ts', symbols: ['totalCents'],
            state: 'verified', evidence: [{ pr: 12, comment: 'c', author: 'reviewer' }], createdAt: '', updatedAt: '',
        }] }));
        const withLesson = buildQualityReceipt(repo, diffFromGit(repo));
        expect(withLesson.notCovered).toEqual([expect.objectContaining({ function: 'formatTotal', lesson: 'Format money from integer cents, never floats.' })]);
        expect(buildQualityReceipt(repo, diffFromGit(repo), { lessonMode: 'off' }).notCovered).toEqual([]);
    });
});
