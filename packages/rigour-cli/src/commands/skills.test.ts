import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installSkills, skillsDoctor } from './skills.js';

describe('Rigour skills', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-skills-'));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('installs native Codex skills with valid discovery metadata', async () => {
        await installSkills(testDir, ['context'], { target: 'codex' });

        const filePath = path.join(testDir, '.agents', 'skills', 'rigour-context', 'SKILL.md');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('name: rigour-context');
        expect(content).toContain('rigour_context_scope');
        expect(content).toContain('repository-wide scan');
    });

    it('installs focused Cursor commands instead of a global rule', async () => {
        await installSkills(testDir, ['verify'], { target: 'cursor' });

        const filePath = path.join(testDir, '.cursor', 'commands', 'rigour-verify.md');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('rigour_check');
        expect(content).toContain('rigour_get_fix_packet');
        expect(content).not.toContain('alwaysApply');
    });

    it('keeps an existing playbook unless force is requested', async () => {
        const filePath = path.join(testDir, '.cursor', 'commands', 'rigour-context.md');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'team customisation');

        await installSkills(testDir, ['context'], { target: 'cursor' });
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('team customisation');

        await installSkills(testDir, ['context'], { target: 'cursor', force: true });
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('rigour_context_scope');
    });

    it('supports a no-write preview and portable playbooks', async () => {
        await installSkills(testDir, ['handoff'], { target: 'universal', dryRun: true });
        expect(fs.existsSync(path.join(testDir, 'docs', 'rigour-skills', 'rigour-handoff.md'))).toBe(false);

        await installSkills(testDir, ['handoff'], { target: 'universal' });
        const content = fs.readFileSync(path.join(testDir, 'docs', 'rigour-skills', 'rigour-handoff.md'), 'utf-8');
        expect(content).toContain('portable Rigour playbook');
        expect(content).toContain('rigour_handoff_accept');
    });

    it('reports missing and installed targets through doctor', async () => {
        await skillsDoctor(testDir);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('missing'));

        await installSkills(testDir, ['all'], { target: 'all' });
        await skillsDoctor(testDir);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('All Rigour playbooks are installed'));
    });
});
