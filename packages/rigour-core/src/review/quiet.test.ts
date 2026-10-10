import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { dismissFinding, findingKey, mustFix, quietSplit, shownSeverity } from './quiet.js';

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

    it('speaks on what must be fixed, the one rule the stop hook and the push gate share: critical, or high and verified or from a security gate', () => {
        const all = [
            { ...finding('frontend-secret-exposure'), severity: 'high' as const, provenance: 'security' as const },
            { ...finding('promise-safety'), severity: 'high' as const },
            { ...finding('promise-safety', 'verified'), severity: 'high' as const, verified: true },
            { ...finding('file-size'), severity: 'critical' as const },
            finding('migration-order'),
        ];
        expect(quietSplit(dir, all).speaking.map(f => f.id)).toEqual(['frontend-secret-exposure', 'promise-safety', 'file-size', 'migration-order']);
        expect(quietSplit(dir, all).advisory.map(f => f.details)).toEqual(['d']);
    });

    it('lets a rule\'s own certainty decide when it sets one: only proven blocks, whatever the gate or severity', () => {
        const proven = { ...finding('promise-safety'), severity: 'medium' as const, certainty: 'proven' as const };
        const likelyCritical = { ...finding('deprecated-apis'), severity: 'critical' as const, certainty: 'likely' as const };
        const possibleOnProvenGate = { ...finding('security-patterns'), certainty: 'possible' as const };
        const advisoryProven = { ...finding('semantic-bugs'), certainty: 'proven' as const, advisory: true };
        expect([proven, likelyCritical, possibleOnProvenGate, advisoryProven].map(mustFix)).toEqual([true, false, false, false]);
        // Without it, the gate-level rule stands, unchanged.
        expect([finding('security-patterns'), { ...finding('deprecated-apis'), severity: 'critical' as const }, finding('promise-safety')].map(mustFix)).toEqual([true, true, false]);
    });

    it('shows a heuristic at most medium: high means an impact Rigour stands behind', () => {
        const at = (over: Partial<Failure>) => shownSeverity({ ...finding('promise-safety'), ...over } as Failure);
        expect(at({ severity: 'high', provenance: 'ai-drift' })).toBe('medium'); // a non-blocking guess
        expect(at({ severity: 'critical', provenance: 'ai-drift', certainty: 'likely' })).toBe('medium');
        expect(at({ id: 'semantic-bugs', severity: 'high' })).toBe('high'); // it blocks: its own
        expect(at({ severity: 'critical', provenance: 'security', certainty: 'likely' })).toBe('critical'); // security keeps its impact
        expect(at({ severity: 'low', provenance: 'ai-drift' })).toBe('low');
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
