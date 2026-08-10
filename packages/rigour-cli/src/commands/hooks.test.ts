/**
 * Tests for hooks init command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hooksInitCommand, hooksCheckCommand } from './hooks.js';
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
        expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('hooks check');
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

    it('should skip a legacy .clinerules file and continue other tools', async () => {
        fs.writeFileSync(path.join(testDir, '.clinerules'), 'legacy Cline rules');

        await expect(hooksInitCommand(testDir, {
            tool: 'cline,windsurf',
        })).resolves.toBeUndefined();

        expect(fs.readFileSync(path.join(testDir, '.clinerules'), 'utf-8'))
            .toBe('legacy Cline rules');
        expect(fs.existsSync(path.join(testDir, '.windsurf', 'hooks.json'))).toBe(true);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('SKIP .clinerules/hooks/PostToolUse'),
        );
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Cline: Not configured'),
        );
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

    it('should propagate --block to generated hook commands', async () => {
        await hooksInitCommand(testDir, { tool: 'all', force: true, block: true });

        const claude = JSON.parse(fs.readFileSync(path.join(testDir, '.claude', 'settings.json'), 'utf-8'));
        const cursor = JSON.parse(fs.readFileSync(path.join(testDir, '.cursor', 'hooks.json'), 'utf-8'));
        const windsurf = JSON.parse(fs.readFileSync(path.join(testDir, '.windsurf', 'hooks.json'), 'utf-8'));
        const clineScript = fs.readFileSync(path.join(testDir, '.clinerules', 'hooks', 'PostToolUse'), 'utf-8');

        expect(claude.hooks.PostToolUse[0].hooks[0].command).toContain('--block');
        expect(cursor.hooks.afterFileEdit[0].command).toContain('--block');
        expect(windsurf.hooks.post_write_code[0].command).toContain('--block');
        expect(clineScript).toContain('--block');
    });
});

describe('hooksInitCommand — DLP integration', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-dlp-test-'));
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

    it('should generate Claude hooks with DLP (PreToolUse) by default', async () => {
        await hooksInitCommand(testDir, { tool: 'claude', force: true });

        const settingsPath = path.join(testDir, '.claude', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        expect(settings.hooks.PostToolUse).toBeDefined();
        expect(settings.hooks.PreToolUse).toBeDefined();
        expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('--mode dlp');
        expect(settings.hooks.PreToolUse[0].hooks[0].command)
            .toMatch(/npx --yes @rigour-labs\/cli@\d+\.\d+\.\d+/);
    });

    it('should generate Cursor hooks with DLP (beforeFileEdit) by default', async () => {
        await hooksInitCommand(testDir, { tool: 'cursor', force: true });

        const hooksPath = path.join(testDir, '.cursor', 'hooks.json');
        const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        expect(hooks.hooks.afterFileEdit).toBeDefined();
        expect(hooks.hooks.beforeSubmitPrompt).toBeDefined();
    });

    it('should generate Windsurf hooks with DLP by default', async () => {
        await hooksInitCommand(testDir, { tool: 'windsurf', force: true });

        const hooksPath = path.join(testDir, '.windsurf', 'hooks.json');
        const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        expect(hooks.hooks.post_write_code).toBeDefined();
        expect(hooks.hooks.pre_write_code).toBeDefined();
    });

    it('should skip DLP hooks when dlp: false', async () => {
        await hooksInitCommand(testDir, { tool: 'claude', force: true, dlp: false });

        const settingsPath = path.join(testDir, '.claude', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        expect(settings.hooks.PostToolUse).toBeDefined();
        expect(settings.hooks.PreToolUse).toBeUndefined();
    });

    it('should generate Cline DLP warnings without default blocking', async () => {
        await hooksInitCommand(testDir, { tool: 'cline', force: true });

        const script = fs.readFileSync(
            path.join(testDir, '.clinerules', 'hooks', 'PreToolUse'),
            'utf-8',
        );
        expect(script).toContain("result.status !== 'clean'");
        expect(script).toContain("if (result.status === 'blocked') process.exit(2)");
    });

    it('should not route DLP hooks through the file-only core checker', async () => {
        const coreChecker = path.join(
            testDir,
            'node_modules/@rigour-labs/core/dist/hooks/standalone-checker.js',
        );
        fs.mkdirSync(path.dirname(coreChecker), { recursive: true });
        fs.writeFileSync(coreChecker, '');
        await hooksInitCommand(testDir, { tool: 'cursor', force: true });

        const hooks = JSON.parse(
            fs.readFileSync(path.join(testDir, '.cursor', 'hooks.json'), 'utf-8'),
        );
        const command = hooks.hooks.beforeSubmitPrompt[0].command;
        expect(command).toMatch(/npx --yes @rigour-labs\/cli@\d+\.\d+\.\d+/);
        expect(command).not.toContain('standalone-checker');
    });
});

describe('hooksCheckCommand', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-check-test-'));
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('should return pass JSON when file is clean', async () => {
        const filePath = path.join(testDir, 'ok.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        await hooksCheckCommand(testDir, { files: 'ok.ts' });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"pass"');
    });

    it('should return fail JSON and set exit code 2 in block mode', async () => {
        const filePath = path.join(testDir, 'bad.ts');
        fs.writeFileSync(filePath, "const password = 'abcdefghijklmnopqrstuvwxyz12345';\n");

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;

        await hooksCheckCommand(testDir, { files: 'bad.ts', block: true });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"fail"');
        expect(stderrSpy).toHaveBeenCalled();
        expect(process.exitCode).toBe(2);
        process.exitCode = originalExitCode;
    });

    it('should warn and continue for DLP detections by default', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;

        await hooksCheckCommand(testDir, {
            mode: 'dlp',
            files: 'AKIAZ9Y8X7W6V5U4T3Q2',
        });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"warning"');
        expect(output).not.toContain('AKIAZ9Y8X7W6V5U4T3Q2');
        expect(stderrSpy).toHaveBeenCalled();
        expect(process.exitCode).toBe(originalExitCode);
    });

    it('should block DLP detections only with --block', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;

        await hooksCheckCommand(testDir, {
            mode: 'dlp',
            files: 'AKIAZ9Y8X7W6V5U4T3Q2',
            block: true,
        });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"blocked"');
        expect(process.exitCode).toBe(2);
        process.exitCode = originalExitCode;
    });
});
