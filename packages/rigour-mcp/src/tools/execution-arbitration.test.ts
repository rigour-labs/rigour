import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueArbitrationToken, signArbitrationDecision } from '@rigour-labs/core';
import { pollArbitration } from './execution-handlers.js';

let cwd: string;
let home: string;
const previousHome = process.env.RIGOUR_HOME;
beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitration-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitration-home-'));
    process.env.RIGOUR_HOME = home; // tokens live outside the workspace: never the real home in tests
    fs.mkdirSync(path.join(cwd, '.rigour'));
});
afterEach(() => {
    if (previousHome === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = previousHome;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

const log = (event: object) => fs.appendFileSync(path.join(cwd, '.rigour/events.jsonl'), JSON.stringify(event) + '\n');

describe('pollArbitration', () => {
    it('ignores an approval any process appended to the event log', async () => {
        const token = await issueArbitrationToken(cwd, 'r1');
        log({ tool: 'human_arbitration', requestId: 'r1', decision: 'approve' });
        expect(await pollArbitration(cwd, 'r1', token, 1)).toBe('timeout-deny');
    });

    it('accepts the decision Studio signed for this request', async () => {
        const token = await issueArbitrationToken(cwd, 'r2');
        log({ tool: 'human_arbitration', requestId: 'r2', decision: 'approve', proof: await signArbitrationDecision(cwd, 'r2', 'approve') });
        expect(await pollArbitration(cwd, 'r2', token, 1)).toBe('approve');
    });
});
