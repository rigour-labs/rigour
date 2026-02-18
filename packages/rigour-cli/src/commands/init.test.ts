/**
 * Tests for init command — IDE detection, config generation, auto-hook integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initCommand } from './init.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('initCommand', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
        // Minimal package.json for discovery
        fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
            name: 'test-project',
            dependencies: { express: '^4.0.0' },
        }));
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('should create rigour.yml', async () => {
        await initCommand(testDir);

        const configPath = path.join(testDir, 'rigour.yml');
        expect(fs.existsSync(configPath)).toBe(true);

        const content = fs.readFileSync(configPath, 'utf-8');
        expect(content).toContain('version');
    });

    it('should create docs/AGENT_INSTRUCTIONS.md', async () => {
        await initCommand(testDir);

        const docsPath = path.join(testDir, 'docs', 'AGENT_INSTRUCTIONS.md');
        expect(fs.existsSync(docsPath)).toBe(true);

        const content = fs.readFileSync(docsPath, 'utf-8');
        expect(content).toContain('Rigour');
    });

    it('should support dry-run mode', async () => {
        await initCommand(testDir, { dryRun: true });

        // Dry run should NOT create rigour.yml
        expect(fs.existsSync(path.join(testDir, 'rigour.yml'))).toBe(false);
    });

    it('should not overwrite without --force', async () => {
        // Create existing rigour.yml
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), 'version: 1\nexisting: true\n');

        await initCommand(testDir);

        const content = fs.readFileSync(path.join(testDir, 'rigour.yml'), 'utf-8');
        expect(content).toContain('existing');
    });

    it('should overwrite with --force', async () => {
        // Create existing rigour.yml
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), 'version: 1\nexisting: true\n');

        await initCommand(testDir, { force: true });

        // Should create backup
        expect(fs.existsSync(path.join(testDir, 'rigour.yml.bak'))).toBe(true);

        // New config should not contain 'existing'
        const content = fs.readFileSync(path.join(testDir, 'rigour.yml'), 'utf-8');
        expect(content).not.toContain('existing: true');
    });

    it('should detect Claude IDE and create hooks', async () => {
        // Create Claude marker
        fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

        await initCommand(testDir);

        // Should have created .claude/settings.json (hooks)
        const settingsPath = path.join(testDir, '.claude', 'settings.json');
        expect(fs.existsSync(settingsPath)).toBe(true);
    });

    it('should detect Cursor IDE and create hooks', async () => {
        // Create Cursor marker
        fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });

        await initCommand(testDir);

        // Should have created .cursor/hooks.json
        const hooksPath = path.join(testDir, '.cursor', 'hooks.json');
        expect(fs.existsSync(hooksPath)).toBe(true);
    });

    it('should update .gitignore with rigour patterns', async () => {
        await initCommand(testDir);

        const gitignorePath = path.join(testDir, '.gitignore');
        expect(fs.existsSync(gitignorePath)).toBe(true);

        const content = fs.readFileSync(gitignorePath, 'utf-8');
        expect(content).toContain('rigour-report.json');
        expect(content).toContain('.rigour/');
    });

    it('should create .rigour/memory.json for Studio', async () => {
        await initCommand(testDir);

        const memPath = path.join(testDir, '.rigour', 'memory.json');
        expect(fs.existsSync(memPath)).toBe(true);

        const mem = JSON.parse(fs.readFileSync(memPath, 'utf-8'));
        expect(mem.memories.project_boot).toBeDefined();
    });

    it('should support --ide flag to target specific IDE', async () => {
        await initCommand(testDir, { ide: 'windsurf' });

        // Should create windsurf rules
        expect(fs.existsSync(path.join(testDir, '.windsurfrules'))).toBe(true);
    });
});
