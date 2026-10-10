/**
 * Tests for hooks init command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readThread } from '@rigour-labs/core';
import { hooksInitCommand, hooksCheckCommand, parseStdinFiles } from './hooks.js';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'yaml';

/** Built at run time: no credential-shaped literal in the source (the release scan refuses one). */
const AWS_KEY = ['AKIA', 'Z9Y8X7W6V5U4T3Q2'].join('');

vi.mock('@rigour-labs/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@rigour-labs/core')>();
    return {
        ...actual,
        recordInteractionEvidence: vi.fn().mockResolvedValue(undefined),
        updateAutomaticIndexForFiles: vi.fn().mockResolvedValue(undefined),
    };
});

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
        // Claude Code sends the edited path as JSON on stdin; it exports no TOOL_INPUT_* variable.
        expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('--stdin');
        expect(settings.hooks.PostToolUse[0].hooks[0].command).not.toContain('TOOL_INPUT');
    });

    it('reads the edited file from the JSON Claude Code sends on stdin', () => {
        expect(parseStdinFiles(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }))).toEqual(['src/a.ts']);
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

    it('merges into a settings file the person already has, keeping their settings and hooks, and stays idempotent', async () => {
        const claudeDir = path.join(testDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npm run format' }] }] } };
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(own));

        for (const force of [false, true, true]) await hooksInitCommand(testDir, { tool: 'claude', force });

        const merged = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
        expect(merged.permissions).toEqual(own.permissions);
        const postToolUse = merged.hooks.PostToolUse.flatMap((group: any) => group.hooks.map((h: any) => h.command));
        expect(postToolUse[0]).toBe('npm run format');
        expect(postToolUse.filter((c: string) => /hooks check/.test(c))).toHaveLength(1); // three runs, one Rigour entry
        expect(merged.hooks.Stop).toHaveLength(1);
    });

    it('leaves a settings file that is not valid JSON alone', async () => {
        const claudeDir = path.join(testDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ not json');
        await hooksInitCommand(testDir, { tool: 'claude', force: true });
        expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')).toBe('{ not json');
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
        const dlp = settings.hooks.PreToolUse.find((h: any) => h.matcher === '.*');
        expect(dlp.hooks[0].command).toContain('--mode dlp');
        expect(dlp.hooks[0].command).toMatch(/npx --yes @rigour-labs\/cli@\d+\.\d+\.\d+/);
        const push = settings.hooks.PreToolUse.find((h: any) => h.matcher === 'Bash');
        expect(push.hooks[0]).toMatchObject({ command: expect.stringContaining('hooks push --stdin'), timeout: 1800 });
        expect(push.hooks[0].command).toContain('case "$payload" in *git*push*)'); // other commands never start Rigour
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
        expect(settings.hooks.PreToolUse.map((h: any) => h.matcher)).toEqual(['Bash']); // the push gate stays
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

    it("keeps each edit check on the task's thread, with the files and the findings", async () => {
        execFileSync('git', ['-C', testDir, 'init', '-q', '-b', 'feat/PROJ-21-thread']);
        fs.writeFileSync(path.join(testDir, 'ok.ts'), 'export const x = 1;\n');
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        await hooksCheckCommand(testDir, { files: 'ok.ts', agent: 'codex' });
        expect(readThread(testDir, 'feat/PROJ-21-thread')?.events.map(e => [e.kind, e.agent, e.files, e.findings, e.status])).toEqual([['edit-check', 'codex', ['ok.ts'], 0, 'pass']]);
    });

    it('reports skipped, not pass, when the hook named no file, and calls out the old hook that passes an empty --files', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await hooksCheckCommand(testDir, { files: '' });
            expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain('"status":"skipped"');
            expect(stderrSpy.mock.calls.map(call => String(call[0])).join('')).toContain('This edit hook is the old form');
            expect(process.exitCode).toBe(1); // shown to the person by the agent, never a block (2)
        } finally {
            process.exitCode = undefined;
        }
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

    it('records a block on the edit check only when the hook ran with --block', async () => {
        fs.writeFileSync(path.join(testDir, 'bad.ts'), "const password = 'abcdefghijklmnopqrstuvwxyz12345';\n");
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;
        await hooksCheckCommand(testDir, { files: 'bad.ts' });
        await hooksCheckCommand(testDir, { files: 'bad.ts', block: true });
        process.exitCode = originalExitCode;
        const checks = fs.readFileSync(path.join(testDir, '.rigour', 'events.jsonl'), 'utf8').trim().split('\n')
            .map(line => JSON.parse(line)).filter(e => e.type === 'hook_check');
        expect(checks.map(e => [e.status, e.blocked])).toEqual([['fail', false], ['fail', true]]);
    });

    it('should warn and continue for DLP detections by default', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;

        await hooksCheckCommand(testDir, {
            mode: 'dlp',
            files: AWS_KEY,
        });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"warning"');
        expect(output).not.toContain(AWS_KEY);
        expect(stderrSpy).toHaveBeenCalled();
        expect(process.exitCode).toBe(originalExitCode);
    });

    it('should block DLP detections only with --block', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const originalExitCode = process.exitCode;

        await hooksCheckCommand(testDir, {
            mode: 'dlp',
            files: AWS_KEY,
            block: true,
        });

        const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
        expect(output).toContain('"status":"blocked"');
        expect(process.exitCode).toBe(2);
        process.exitCode = originalExitCode;
    });
});

describe('which agent sent the hook payload', () => {
    let repo: string;
    let stdout: string;
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const originalExitCode = process.exitCode;

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-payload-'));
        execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'feat/retry']);
        fs.mkdirSync(path.join(repo, 'src', 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'AGENTS.md'), '- Every job in `src/jobs/` must call `withLock()` before its first read.\n');
        stdout = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { stdout += String(chunk); return true; });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        Object.defineProperty(process, 'stdin', originalStdin);
        process.exitCode = originalExitCode;
        vi.restoreAllMocks();
        fs.rmSync(repo, { recursive: true, force: true });
    });

    /** Runs the hook with this payload on stdin, as the agent runs it; returns what it wrote to stdout, parsed. */
    const run = async (payload: object, options: Parameters<typeof hooksCheckCommand>[1]) => {
        Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(payload))]), configurable: true });
        await hooksCheckCommand(repo, { stdin: true, ...options });
        return JSON.parse(stdout);
    };
    /** What Claude Code sends to a PreToolUse or PostToolUse hook, in full. */
    const claude = (event: 'PreToolUse' | 'PostToolUse', file: string, content: string) => ({
        session_id: 'a1b2c3', transcript_path: path.join(repo, 't.jsonl'), cwd: repo, permission_mode: 'default', hook_event_name: event,
        tool_name: 'Write', tool_input: { file_path: path.join(repo, file), content },
        ...(event === 'PostToolUse' ? { tool_response: { filePath: path.join(repo, file), success: true } } : {}),
    });
    /** What Cursor sends, in full. */
    const cursor = (event: string, extra: object) => ({
        conversation_id: 'c1', generation_id: 'g1', hook_event_name: event, workspace_roots: [repo], ...extra,
    });

    it("denies a Claude Code tool call that writes a credential in a real secret's format, with the reason Claude is shown", async () => {
        const out = await run(claude('PreToolUse', 'src/jobs/k.ts', `const k = "${AWS_KEY}";`), { mode: 'dlp' });
        expect(out.continue).toBeUndefined(); // it used to scan nothing and answer continue
        expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('[aws_access_key]') });
    });

    it('lets a credential the scan only suspects through, with a warning Claude sees', async () => {
        const out = await run(claude('PreToolUse', 'src/jobs/db.ts', 'const url = "postgres://admin:Zq8Lr2Vt9@db.example.com:5432/app";'), { mode: 'dlp' });
        expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
        expect(out.hookSpecificOutput.additionalContext).toContain('not blocked');
    });

    it("briefs a Claude Code agent on a file's first edit", async () => {
        const out = await run(claude('PreToolUse', 'src/jobs/retry.ts', 'export {};'), { mode: 'dlp', brief: true });
        expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('must call `withLock()`') });
    });

    it("answers a Claude Code edit check in Claude Code's format, and an unknown event the same way", async () => {
        fs.writeFileSync(path.join(repo, 'src/jobs/retry.ts'), 'export const x = 1;\n');
        expect(await run(claude('PostToolUse', 'src/jobs/retry.ts', ''), {})).toMatchObject({ status: 'pass' });
        stdout = '';
        expect(await run({ ...claude('PostToolUse', 'src/jobs/retry.ts', ''), hook_event_name: 'SomethingNew' }, {})).toMatchObject({ status: 'pass' });
    });

    it("still answers Cursor in Cursor's format", async () => {
        const prompt = await run(cursor('beforeSubmitPrompt', { prompt: `my key is ${AWS_KEY}` }), { mode: 'dlp' });
        expect(prompt).toMatchObject({ continue: true, user_message: expect.stringContaining('credential') });
        stdout = '';
        fs.writeFileSync(path.join(repo, 'src/jobs/retry.ts'), 'export const x = 1;\n');
        expect(await run(cursor('afterFileEdit', { file_path: path.join(repo, 'src/jobs/retry.ts'), edits: [] }), {})).toEqual({ continue: true });
    });
});

