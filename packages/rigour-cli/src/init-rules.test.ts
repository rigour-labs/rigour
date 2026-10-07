import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { initCommand } from './commands/init.js';

describe('rigour init: agents and instruction files', () => {
    let testDir: string;
    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-init-rules-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(testDir);
    });

    it('writes one AGENTS.md and a CLAUDE.md that imports it, and nothing per agent', async () => {
        await initCommand(testDir, { instructions: true });

        expect(await fs.readFile(path.join(testDir, 'AGENTS.md'), 'utf-8')).toContain('rigour review --base origin/main');
        expect(await fs.readFile(path.join(testDir, 'CLAUDE.md'), 'utf-8')).toBe('@AGENTS.md\n');
        for (const rel of ['docs/AGENT_INSTRUCTIONS.md', '.cursor/rules/rigour.mdc', '.clinerules/rigour.md', '.windsurfrules', '.gemini/styleguide.md']) {
            expect(await fs.pathExists(path.join(testDir, rel)), rel).toBe(false);
        }
    });

    it("keeps the team's own instruction files and says what to add", async () => {
        await fs.writeFile(path.join(testDir, 'AGENTS.md'), '# Ours\n');
        await fs.writeFile(path.join(testDir, 'CLAUDE.md'), '# Ours too\n');
        await initCommand(testDir, { instructions: true });

        expect(await fs.readFile(path.join(testDir, 'AGENTS.md'), 'utf-8')).toBe('# Ours\n');
        expect(await fs.readFile(path.join(testDir, 'CLAUDE.md'), 'utf-8')).toBe('# Ours too\n');
        const said = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(said).toContain("Kept your AGENTS.md: add Rigour's section");
        expect(said).toContain('add a line "@AGENTS.md"');
    });

    it('sets up only the agents the repository uses: Claude Code when it shows none', async () => {
        await initCommand(testDir);
        expect(await fs.pathExists(path.join(testDir, '.claude', 'settings.json'))).toBe(true);
        for (const rel of ['.cursor', '.clinerules', '.windsurf']) expect(await fs.pathExists(path.join(testDir, rel)), rel).toBe(false);
    });

    it('sets up an agent the repository shows signs of, or the ones asked for', async () => {
        await fs.ensureDir(path.join(testDir, '.cursor'));
        await initCommand(testDir);
        expect(await fs.pathExists(path.join(testDir, '.cursor', 'hooks.json'))).toBe(true);
        expect(await fs.pathExists(path.join(testDir, '.windsurf'))).toBe(false);

        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-init-rules-'));
        try {
            await initCommand(other, { ide: 'windsurf' });
            expect(await fs.pathExists(path.join(other, '.windsurf', 'hooks.json'))).toBe(true);
            expect(await fs.pathExists(path.join(other, '.claude', 'settings.json'))).toBe(false);
        } finally {
            await fs.remove(other);
        }
    });
});
