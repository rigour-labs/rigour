import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

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
