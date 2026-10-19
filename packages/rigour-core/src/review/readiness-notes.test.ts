import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { readiness } from './readiness.js';
import { readinessLine } from './readiness-render.js';
import { reviewChange } from './review.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-notes-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('supabase/migrations/20260101000000_jobs.sql', 'create table acme_jobs (id uuid primary key default gen_random_uuid(), name text not null, ran_at timestamptz not null default now());\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('readiness and a write contract note', () => {
    it('is ready, with the note counted as noted and the write-contract row noted, never failed', async () => {
        write('src/sync.ts', "import { createClient } from '@supabase/supabase-js';\n\nexport const sync = () => createClient('https://example.supabase.co', 'anon').from('acme_jobs').insert([{ name: 'a', ran_at: '2026-10-01' }, { name: 'b' }]);\n");
        const config = ConfigSchema.parse({ version: 1, gates: { unused_exports: { enabled: false }, orphan_files: { enabled: false }, hallucinated_imports: { enabled: false } } });
        const review = await reviewChange({ cwd: repo, config });
        expect(review.findings).toEqual([]);
        expect(review.advisory.map(f => f.id)).toEqual(['write-contract']);
        expect(review.report?.summary['write-contract']).toBe('NOTE');
        expect(review.blockingByCheck['write-contract']).toBeUndefined();
        const r = readiness({ review, reviewerAsked: false });
        expect(r.technical.state).toBe('ready');
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'write-contract', state: 'noted', detail: 'notes, not blocking' });
        expect(readinessLine(r)).toMatch(/^Technically ready: ready \([^)]*; 1 noted\)/);
    });
});
