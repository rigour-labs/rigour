import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { dismissFinding, findingKey, quietSplit } from './quiet.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const finding = (id: string, details = 'd', line = 3): Failure => ({ id, title: id, details, files: ['src/a.ts'], line });

describe('quiet by default', () => {
    it('lets only findings that prove a defect speak; heuristics are advisory unless the team asks for them', () => {
        const all = [finding('semantic-bugs'), finding('security-patterns'), finding('promise-safety'), finding('file-size'), finding('deep-analysis')];
        const quiet = quietSplit(dir, all);
        expect(quiet.speaking.map(f => f.id)).toEqual(['semantic-bugs', 'security-patterns', 'deep-analysis']);
        expect(quiet.advisory.map(f => f.id)).toEqual(['promise-safety', 'file-size']);
        expect(quietSplit(dir, all, true).speaking).toHaveLength(5);
    });

    it('never reports a dismissed finding again, even after its line moves', () => {
        const leak = finding('security-patterns', 'Hardcoded token in `client`');
        expect(dismissFinding(dir, findingKey(leak), 'test fixture token, never deployed')).toBe(true);
        expect(dismissFinding(dir, findingKey(leak), 'again')).toBe(true); // idempotent
        const moved = { ...leak, line: 40 };
        expect(quietSplit(dir, [moved, finding('semantic-bugs')])).toMatchObject({ dismissed: 1, dismissedByGate: { 'security-patterns': 1 }, speaking: [expect.objectContaining({ id: 'semantic-bugs' })] });
        expect(JSON.parse(fs.readFileSync(path.join(dir, '.rigour/dismissed.json'), 'utf8')).entries).toHaveLength(1);
        expect(dismissFinding(dir, 'not-a-key', 'x')).toBe(false);
    });
});
