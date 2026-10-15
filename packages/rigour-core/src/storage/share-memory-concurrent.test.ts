/**
 * Two agents remembering the same team memory key at the same moment, from two processes on one machine: both
 * succeed, and one candidate is left for the key, the other superseded. Each process opens its own connection to the
 * same local store, as two MCP servers do; a deferred transaction would fail one of them with SQLITE_BUSY.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-race-home-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-race-repo-'));
fs.mkdirSync(path.join(repo, '.git'));
fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
const lessons = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'storage', 'lessons.js');
const db = path.join(path.dirname(lessons), 'db.js');

const remember = (value: string) => new Promise<{ code: number | null; out: string }>(resolve => {
    const script = `import(${JSON.stringify(lessons)}).then(m => m.shareMemoryLesson(${JSON.stringify(repo)}, 'retries', ${JSON.stringify(value)})).then(id => console.log(id), e => { console.error(String(e)); process.exit(1); })`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, RIGOUR_HOME: home, RIGOUR_ACTOR_ID: 'dev-a', RIGOUR_TEAM_ID: 'web' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
});

describe.skipIf(!fs.existsSync(lessons))('two processes remembering the same key at once', () => {
    afterAll(() => { for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true }); });

    it('both succeed, and leave one candidate', async () => {
        const runs = await Promise.all([remember('Use withRetry.'), remember('Use withRetry, three attempts.'), remember('Use withRetry from lib/net.')]);
        for (const run of runs) expect(run, run.out).toMatchObject({ code: 0 });
        process.env.RIGOUR_HOME = home;
        const { openDatabase } = await import(db);
        const store = await openDatabase();
        try {
            const states = (await store.all("SELECT state FROM lessons WHERE kind = 'memory'")).map((r: { state: string }) => r.state).sort();
            expect(states).toEqual(['candidate', 'superseded', 'superseded']);
        } finally {
            await store.close();
        }
    }, 60_000);
});
