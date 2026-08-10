import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeHookFiles, writeHookFiles } from './hook-file-writer.js';

describe('writeHookFiles', () => {
    const testDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(testDirs.splice(0).map(testDir => fs.remove(testDir)));
    });

    it('isolates legacy config collisions and continues other hook writes', async () => {
        const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hooks-test-'));
        testDirs.push(testDir);
        await fs.writeFile(path.join(testDir, '.clinerules'), 'legacy rules');

        const result = await writeHookFiles(testDir, [
            { path: '.clinerules/hooks/PreToolUse', content: 'cline' },
            { path: '.windsurf/hooks.json', content: '{}' },
        ], false);

        expect(result.incompatible).toEqual(['.clinerules/hooks/PreToolUse']);
        expect(result.written).toEqual(['.windsurf/hooks.json']);
        expect(await fs.readFile(path.join(testDir, '.clinerules'), 'utf-8')).toBe('legacy rules');
    });

    it('combines quality and DLP events targeting the same config file', () => {
        const files = mergeHookFiles([
            { path: '.cursor/hooks.json', content: JSON.stringify({ version: 1, hooks: { afterFileEdit: [{}] } }) },
            { path: '.cursor/hooks.json', content: JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{}] } }) },
        ]);

        expect(files).toHaveLength(1);
        expect(JSON.parse(files[0].content).hooks).toEqual({
            afterFileEdit: [{}],
            beforeSubmitPrompt: [{}],
        });
    });
});
