/**
 * Tests for hooks init command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hooksInitCommand } from './hooks.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'yaml';

describe('hooksInitCommand', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
        // Write minimal rigour.yml
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
            version: 1,
            gates: { max_file_lines: 500 },
        }));
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('should generate Claude hooks', async () => {
        await hooksInitCommand(testDir, { tool: 'claude' });

        const settingsPath = path.join(testDir, '.claude', 'settings.json');
        expect(fs.existsSync(settingsPath)).toBe(true);

        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        expect(settings.hooks).toBeDefined();
        expect(settings.hooks.PostToolUse).toBeDefined();
    });

    it('should generate Cursor hooks', async () => {
        await hooksInitCommand(testDir, { tool: 'cursor' });

        const hooksPath = path.join(testDir, '.cursor', 'hooks.json');
        expect(fs.existsSync(hooksPath)).toBe(true);

        const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        expect(hooks.hooks).toBeDefined();
    });

    it('should generate Cline hooks', async () => {
        await hooksInitCommand(testDir, { tool: 'cline' });

        const hookPath = path.join(testDir, '.clinerules', 'hooks', 'PostToolUse');
        expect(fs.existsSync(hookPath)).toBe(true);
    });

    it('should generate Windsurf hooks', async () => {
        await hooksInitCommand(testDir, { tool: 'windsurf' });

        const hooksPath = path.join(testDir, '.windsurf', 'hooks.json');
        expect(fs.existsSync(hooksPath)).toBe(true);
    });

    it('should support dry-run mode', async () => {
        await hooksInitCommand(testDir, { tool: 'claude', dryRun: true });

        // Dry run should NOT create files
        const settingsPath = path.join(testDir, '.claude', 'settings.json');
        expect(fs.existsSync(settingsPath)).toBe(false);
    });

    it('should not overwrite without --force', async () => {
        // Create existing file
        const claudeDir = path.join(testDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"existing": true}');

        await hooksInitCommand(testDir, { tool: 'claude' });

        // Should keep existing content
        const content = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8');
        expect(content).toContain('existing');
    });

    it('should overwrite with --force', async () => {
        // Create existing file
        const claudeDir = path.join(testDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"existing": true}');

        await hooksInitCommand(testDir, { tool: 'claude', force: true });

        // Should have new hooks content
        const content = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8');
        expect(content).toContain('PostToolUse');
    });
});
