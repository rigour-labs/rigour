import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookChecker } from './checker.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const UNEVEN = `import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://example.supabase.co', 'anon');
export const sync = (orgId: string) =>
  supabase.from('acme_jobs').upsert([{ org_id: orgId, name: 'a', ran_at: 'x' }, { org_id: orgId, name: 'b' }]);
`;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-write-contract-'));
    write('supabase/migrations/20260101000000_jobs.sql', 'create table acme_jobs (id bigint generated always as identity primary key, org_id uuid not null, name text not null, ran_at timestamptz not null default now());');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('the edit hook and the write contract', () => {
    it('warns about a write the database will reject, as a note that never blocks', async () => {
        write('rigour.yml', yaml.stringify({ version: 1 }));
        write('src/sync.ts', UNEVEN);
        const result = await runHookChecker({ cwd: repo, files: ['src/sync.ts'] });
        expect(result.status).toBe('pass');
        expect(result.notes).toEqual([expect.objectContaining({ gate: 'write-contract', file: path.join('src', 'sync.ts'), line: 4, message: expect.stringContaining("don't all set `ran_at`") })]);
    });

    it('blocks it when the team opts in, and says nothing when the team turns it off', async () => {
        write('src/sync.ts', UNEVEN);
        write('rigour.yml', yaml.stringify({ version: 1, gates: { write_contract: { block: true } } }));
        const blocked = await runHookChecker({ cwd: repo, files: ['src/sync.ts'] });
        expect(blocked.status).toBe('fail');
        expect(blocked.failures.map(f => f.gate)).toEqual(['write-contract']);
        write('rigour.yml', yaml.stringify({ version: 1, gates: { write_contract: { enabled: false } } }));
        const off = await runHookChecker({ cwd: repo, files: ['src/sync.ts'] });
        expect(off.failures).toEqual([]);
        expect(off.notes).toBeUndefined();
    });
});
