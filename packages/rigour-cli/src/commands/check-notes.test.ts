import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCommand } from './check.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};

/** Runs `rigour check --json` and returns its exit code and report. */
async function check(): Promise<{ code: number | undefined; report: any }> {
    let out = '';
    let code: number | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, done?: () => void) => { out += chunk; done?.(); return true; }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c; }) as never);
    await checkCommand(repo, [], { json: true, cache: false });
    return { code, report: JSON.parse(out) };
}

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'check-notes-'));
    // Everything else the default gates ask for, so the write contract's finding is the only one.
    write('package.json', JSON.stringify({ name: 'acme-jobs', dependencies: { '@supabase/supabase-js': '^2.45.0' } }));
    for (const doc of ['SPEC', 'ARCH', 'DECISIONS', 'TASKS']) write(`docs/${doc}.md`, `# ${doc}\n`);
    write('supabase/migrations/20260101000000_jobs.sql', 'create table acme_jobs (id uuid primary key default gen_random_uuid(), name text not null, ran_at timestamptz not null default now());');
    write('src/sync.ts', "import { createClient } from '@supabase/supabase-js';\n\nexport const sync = () => createClient('https://example.supabase.co', 'anon').from('acme_jobs').insert([{ name: 'a', ran_at: '2026-10-01' }, { name: 'b' }]);\n");
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('rigour check and a check that does not block', () => {
    it('reports a write contract finding and still passes with the default config', async () => {
        write('rigour.yml', 'version: 1\n');
        const { code, report } = await check();
        expect(report.failures.map((f: any) => f.id)).toEqual(['write-contract']);
        expect(report.status).toBe('PASS');
        expect(code).toBe(0);
    });

    it('fails on it once the team opts in to blocking', async () => {
        write('rigour.yml', 'version: 1\ngates:\n  write_contract:\n    block: true\n');
        const { code, report } = await check();
        expect(report.status).toBe('FAIL');
        expect(code).toBe(1);
    });
});
