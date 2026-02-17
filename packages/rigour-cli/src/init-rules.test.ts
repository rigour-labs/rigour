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
        await initCommand(testDir, { ide: 'all' });

        const instructionsPath = path.join(testDir, 'docs', 'AGENT_INSTRUCTIONS.md');
        const mdcPath = path.join(testDir, '.cursor', 'rules', 'rigour.mdc');

        expect(await fs.pathExists(instructionsPath)).toBe(true);
        expect(await fs.pathExists(mdcPath)).toBe(true);

        const instructionsContent = await fs.readFile(instructionsPath, 'utf-8');
        const mdcContent = await fs.readFile(mdcPath, 'utf-8');

        // Check for agnostic instructions
        expect(instructionsContent).toContain('# 🤖 CRITICAL INSTRUCTION FOR AI');
        expect(instructionsContent).toContain('VERIFICATION PROOF REQUIRED');

        // Check for key sections in universal instructions
        expect(instructionsContent).toContain('# 🛡️ Rigour: Mandatory Engineering Governance Protocol');
        expect(instructionsContent).toContain('# Code Quality Standards');

        // Check that MDC includes agnostic rules
        expect(mdcContent).toContain('# 🤖 CRITICAL INSTRUCTION FOR AI');
    });

    it('should create .clinerules when ide is cline or all', async () => {
        const initCommand = await getInitCommand();
        await initCommand(testDir, { ide: 'cline' });
        const clineRulesPath = path.join(testDir, '.clinerules');
        expect(await fs.pathExists(clineRulesPath)).toBe(true);

        const content = await fs.readFile(clineRulesPath, 'utf-8');
        expect(content).toContain('# 🤖 CRITICAL INSTRUCTION FOR AI');
    });

});
