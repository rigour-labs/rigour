import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMcpGetSettings, handleMcpSetSettings } from './mcp-settings-handler.js';

describe('mcp settings handlers', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-mcp-settings-'));
        await fs.ensureDir(path.join(testDir, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testDir);
    });

    it('returns default settings when file is missing', async () => {
        const result = await handleMcpGetSettings(testDir);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.deep_default_mode).toBe('off');
    });

    it('persists deep_default_mode through set/get', async () => {
        const setResult = await handleMcpSetSettings(testDir, { deep_default_mode: 'quick' });
        expect(setResult.isError).toBeUndefined();

        const getResult = await handleMcpGetSettings(testDir);
        const parsed = JSON.parse(getResult.content[0].text);
        expect(parsed.deep_default_mode).toBe('quick');
    });

    it('rejects invalid deep_default_mode', async () => {
        const result = await handleMcpSetSettings(testDir, { deep_default_mode: 'invalid' });
        expect(result.isError).toBe(true);
    });
});
