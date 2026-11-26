import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { alive, descendants, endJudgeProcesses, processesIn } from './judge-processes.js';

const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50));
};

describe.skipIf(process.platform === 'win32')('ending what a judge started', () => {
    it('finds a process by its parent, by its working directory in the copy, and ends both, in whatever session they are', async () => {
        const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-processes-')));
        const elsewhere = fs.realpathSync(os.tmpdir());
        // A judge (its own group) whose shell started one command in the copy and one, in a session of its own, elsewhere.
        const judge = spawn('sh', ['-c', `(cd ${JSON.stringify(elsewhere)} && exec sleep 301) & (cd ${JSON.stringify(copy)} && exec sleep 302) & wait`], { detached: true, stdio: 'ignore' });
        let below: number[] = [];
        await waitFor(() => (below = descendants(judge.pid!)).length >= 2);
        expect(below.length).toBeGreaterThanOrEqual(2);
        await waitFor(() => processesIn(copy).length > 0);
        const inCopy = processesIn(copy);
        expect(inCopy.length).toBeGreaterThan(0);
        expect(inCopy.every(pid => below.includes(pid) || pid === judge.pid)).toBe(true);
        endJudgeProcesses(judge.pid, copy);
        await waitFor(() => ![judge.pid!, ...below].some(alive));
        expect([judge.pid!, ...below].filter(alive)).toEqual([]);
        fs.rmSync(copy, { recursive: true, force: true });
    });
});
