import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveCwd } from './config.js';

describe('loadConfig', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.restoreAllMocks(); });

    it('uses defaults without writing anything when the repository has no rigour.yml', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const config = await loadConfig(dir);
        expect(config.version).toBe(1);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("reads the repository's rigour.yml when it has one", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
        fs.writeFileSync(path.join(dir, 'rigour.yml'), 'version: 1\ngates:\n  semantic_bugs:\n    enabled: true\n');
        expect((await loadConfig(dir)).gates.semantic_bugs?.enabled).toBe(true);
    });
});

describe('resolveCwd', () => {
    const configured = process.env.RIGOUR_CWD;
    afterEach(() => { if (configured === undefined) delete process.env.RIGOUR_CWD; else process.env.RIGOUR_CWD = configured; });

    it("prefers the call's cwd, then RIGOUR_CWD, then where the server started", () => {
        process.env.RIGOUR_CWD = '/repos/configured';
        expect(resolveCwd({ cwd: '/repos/given' })).toBe('/repos/given');
        expect(resolveCwd({})).toBe('/repos/configured');
        expect(resolveCwd({ cwd: 42 })).toBe('/repos/configured');
        delete process.env.RIGOUR_CWD;
        expect(resolveCwd(undefined)).toBe(process.cwd());
    });
});
