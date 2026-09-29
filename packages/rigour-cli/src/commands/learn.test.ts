import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { learnCommand } from './learn.js';

const BEFORE = "export async function post(url: string, init: RequestInit) {\n  return fetch(url, init);\n}\n";
const AFTER = "export async function post(url: string, init: RequestInit) {\n  return fetch(url, { ...init, redirect: 'manual' });\n}\n";

describe('learnCommand', () => {
    let cwd: string;
    let log: MockInstance<unknown[], void>;
    let error: MockInstance<unknown[], void>;
    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-cli-'));
        fs.mkdirSync(path.join(cwd, 'src'));
        fs.writeFileSync(path.join(cwd, 'old.ts'), BEFORE);
        fs.writeFileSync(path.join(cwd, 'src', 'http.ts'), AFTER);
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        error = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.exitCode = undefined;
    });
    afterEach(() => {
        log.mockRestore();
        error.mockRestore();
        process.exitCode = undefined;
        fs.rmSync(cwd, { recursive: true, force: true });
    });

    it('learns from --before/--after and saves the rule', async () => {
        await learnCommand(cwd, undefined, { before: 'old.ts', after: 'src/http.ts' });
        const saved = fs.readdirSync(path.join(cwd, '.rigour', 'rules'));
        expect(saved).toHaveLength(1);
        const rule = JSON.parse(fs.readFileSync(path.join(cwd, '.rigour', 'rules', saved[0]), 'utf8'));
        expect(rule.pattern).toMatchObject({ template: 'require-option', property: 'redirect', value: 'manual' });
        expect(rule.source).toEqual({ file: 'src/http.ts', function: 'post' });
    });

    it('saves nothing on --dry-run and reports JSON', async () => {
        await learnCommand(cwd, undefined, { before: 'old.ts', after: 'src/http.ts', dryRun: true, json: true });
        expect(fs.existsSync(path.join(cwd, '.rigour'))).toBe(false);
        const report = JSON.parse(String(log.mock.calls[0][0]));
        expect(report.learned).toHaveLength(1);
        expect(report.saved).toEqual([]);
    });

    it('rejects missing or conflicting inputs with a usage exit code', async () => {
        await learnCommand(cwd, undefined, { before: 'old.ts' });
        expect(process.exitCode).toBe(2);
        await learnCommand(cwd, 'abc123', { before: 'old.ts', after: 'src/http.ts' });
        expect(error.mock.calls.flat().join('\n')).toContain('not both');
        await learnCommand(cwd, undefined, { before: 'old.ts', after: 'src/http.ts', maxHits: '-1' });
        expect(error.mock.calls.flat().join('\n')).toContain('--max-hits');
    });
});
