import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { diffFromGit } from './git-diff.js';
import { addedFiles, migrationOrderFailures } from './migration-order.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body = 'select 1;\n') => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); };
const config = (enabled = true) => ConfigSchema.parse({ version: 1, gates: { migration_order: { enabled } } });
const DIR = 'supabase/migrations';

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-order-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write(`${DIR}/20260101000000_init.sql`);
    commit('init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('migrationOrderFailures', () => {
    it('flags a branch migration dated before one main merged since', () => {
        git('checkout', '-q', '-b', 'feature');
        write(`${DIR}/20260107000000_feature.sql`);
        commit('feature');
        git('checkout', '-q', 'main');
        write(`${DIR}/20260110000000_main.sql`);
        commit('main moved');
        git('checkout', '-q', 'feature');

        const source = { mode: 'base' as const, base: 'main' };
        const failures = migrationOrderFailures(repo, diffFromGit(repo, source), source, config());

        expect(failures).toEqual([expect.objectContaining({
            id: 'migration-order', files: [`${DIR}/20260107000000_feature.sql`], line: 1,
        })]);
        expect(failures[0].details).toContain('20260110000000_main.sql');
    });

    it('passes a migration dated after the newest on the base, and uncommitted work against HEAD', () => {
        write(`${DIR}/20260201000000_next.sql`);
        expect(migrationOrderFailures(repo, diffFromGit(repo), { mode: 'working' }, config())).toEqual([]);
        write(`${DIR}/20251231000000_old.sql`);
        expect(migrationOrderFailures(repo, diffFromGit(repo), { mode: 'working' }, config()).map(f => f.files)).toEqual([[`${DIR}/20251231000000_old.sql`]]);
    });

    it('checks only the configured directories, and only when enabled', () => {
        write('db/migrations/0001_old.sql');
        write(`${DIR}/20251231000000_old.sql`);
        expect(migrationOrderFailures(repo, diffFromGit(repo), { mode: 'working' }, config(false))).toEqual([]);
        expect(migrationOrderFailures(repo, diffFromGit(repo), { mode: 'working' }, config()).map(f => f.files![0])).toEqual([`${DIR}/20251231000000_old.sql`]);
    });
});

describe('addedFiles', () => {
    it('lists only files the diff creates', () => {
        const diff = ['--- /dev/null', '+++ b/new.sql', '@@ -0,0 +1 @@', '+x', '--- a/old.sql', '+++ b/old.sql'].join('\n');
        expect(addedFiles(diff)).toEqual(['new.sql']);
    });
});
