import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { alive, endJudgeProcesses } from './judge-processes.js';

const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50));
};

describe.skipIf(process.platform === 'win32')('ending what a judge started', () => {
    it('ends the judge, a child in a session of its own outside the copy, and an orphan still working in the copy', async () => {
        const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-processes-')));
        const pids = path.join(copy, 'pids');
        // The orphan: started in the copy, its parent gone, in no group or tree of the judge's.
        spawn('sh', ['-c', `(exec sleep 303) & echo $! >> ${JSON.stringify(pids)}`], { cwd: copy, detached: true, stdio: 'ignore' });
        // The judge, in a group of its own, with a child in a session of its own outside the copy.
        const judge = spawn(process.execPath, ['-e', `const c = require('child_process').spawn('sleep', ['301'], { cwd: '/', detached: true, stdio: 'ignore' }); require('fs').appendFileSync(${JSON.stringify(pids)}, c.pid + '\\n'); setInterval(() => {}, 1000);`], { detached: true, stdio: 'ignore' });
        const started = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
        await waitFor(() => started().length === 2);
        const all = [judge.pid!, ...started()];
        expect(all.every(alive)).toBe(true);
        endJudgeProcesses(judge.pid, copy);
        await waitFor(() => !all.some(alive));
        expect(all.filter(alive)).toEqual([]);
        fs.rmSync(copy, { recursive: true, force: true });
    });
});
