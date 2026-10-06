import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';


import fs from 'fs-extra';
import path from 'path';
import os from 'os';

async function getInitCommand() {
    const { initCommand } = await import('./commands/init.js');
    return initCommand;
}

describe('Init Command Rules Verification', () => {
    const testDir = path.join(os.tmpdir(), 'rigour-temp-init-rules-test-' + process.pid);

    beforeEach(async () => {
        await fs.ensureDir(testDir);
    });

    afterEach(async () => {
        await fs.remove(testDir);
    });

    it('should create instructions with agnostic rules and cursor rules on init', async () => {
        const initCommand = await getInitCommand();
        // Run init in test directory with all IDEs to verify rules in both locations
        await initCommand(testDir, { ide: 'all', instructions: true });

        const instructionsPath = path.join(testDir, 'docs', 'AGENT_INSTRUCTIONS.md');
        const mdcPath = path.join(testDir, '.cursor', 'rules', 'rigour.mdc');

        expect(await fs.pathExists(instructionsPath)).toBe(true);
        expect(await fs.pathExists(mdcPath)).toBe(true);

        const instructionsContent = await fs.readFile(instructionsPath, 'utf-8');
        const mdcContent = await fs.readFile(mdcPath, 'utf-8');

        // Check for agnostic instructions
        expect(instructionsContent).toContain('# Rigour Quality Gates');
        expect(instructionsContent).toContain('Verification');

        // Check for key sections in universal instructions
        expect(instructionsContent).toContain('# Rigour: Engineering Governance');
        expect(instructionsContent).toContain('# Code Quality Standards');

        // Check that MDC includes governance rules
        expect(mdcContent).toContain('# Rigour Governance');
    });

    it('writes Cline rules into the .clinerules folder next to its hooks', async () => {
        const initCommand = await getInitCommand();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await initCommand(testDir, { ide: 'all', instructions: true });
        const output = log.mock.calls.flat().join('\n');
        log.mockRestore();

        const content = await fs.readFile(path.join(testDir, '.clinerules', 'rigour.md'), 'utf-8');
        expect(content).toContain('# Rigour: Engineering Governance');
        expect(await fs.pathExists(path.join(testDir, '.clinerules', 'hooks', 'PostToolUse'))).toBe(true);
        expect(output).not.toContain('SKIP .clinerules');
    });

    it('keeps a legacy .clinerules file', async () => {
        await fs.writeFile(path.join(testDir, '.clinerules'), 'team rules');
        const initCommand = await getInitCommand();
        await initCommand(testDir, { ide: 'cline', instructions: true });
        expect(await fs.readFile(path.join(testDir, '.clinerules'), 'utf-8')).toBe('team rules');
    });

    it('keeps existing agent files and says so, unless --force', async () => {
        await fs.writeFile(path.join(testDir, 'AGENTS.md'), '# Ours');
        await fs.writeFile(path.join(testDir, 'CLAUDE.md'), '# Ours too');
        const initCommand = await getInitCommand();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await initCommand(testDir, { ide: 'all', instructions: true });
        const output = log.mock.calls.flat().join('\n');
        log.mockRestore();

        expect(await fs.readFile(path.join(testDir, 'AGENTS.md'), 'utf-8')).toBe('# Ours');
        expect(await fs.readFile(path.join(testDir, 'CLAUDE.md'), 'utf-8')).toBe('# Ours too');
        expect(output).toContain('Kept existing AGENTS.md');
        expect(output).toContain('Kept existing CLAUDE.md');

        await initCommand(testDir, { ide: 'all', force: true, instructions: true });
        expect(await fs.readFile(path.join(testDir, 'AGENTS.md'), 'utf-8')).toContain('# AGENTS.md');
    });

});
