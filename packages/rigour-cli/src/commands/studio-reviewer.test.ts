import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dismissFromStudio, loadStudioReviewer, saveStudioReviewer, saveTeamReviewer } from './studio-reviewer.js';

let repo: string;
let home: string;
const savedHome = process.env.RIGOUR_HOME;

beforeEach(() => {
    // A home of its own for the person's settings: the shared test home is never written by another test's choice.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-reviewer-'));
    process.env.RIGOUR_HOME = home;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reviewer-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => {
    process.env.RIGOUR_HOME = savedHome;
    for (const dir of [repo, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the reviewer in Studio', () => {
    it('shows the defaults, where each value comes from, and which agent CLIs exist', async () => {
        const view = await loadStudioReviewer(repo);
        expect(view).toMatchObject({ branch: 'feature', teamFile: false, user: {}, effective: { enabled: false, mode: 'single', panel: false, source: { mode: 'team', panel: 'team' } } });
        expect(view.team).toMatchObject({ mode: 'single', panel: 'off', judges: 2, escalate: 'always' });
        expect(view.available.map(a => a.name)).toEqual(['claude', 'cursor', 'codex']);
    });

    it('saves a person\'s own choice, applies it over the team\'s, and goes back to the team\'s on null', async () => {
        const on = await saveStudioReviewer(repo, { enabled: true, panel: true, judges: 3 });
        expect(on.user).toEqual({ enabled: true, panel: true, judges: 3 });
        expect(on.effective).toMatchObject({ enabled: true, mode: 'full', panel: true, judges: 3, source: { panel: 'user' } });
        const back = await saveStudioReviewer(repo, { panel: null });
        expect(back.user).toEqual({ enabled: true, judges: 3 });
        expect(back.effective.panel).toBe(false);
    });

    it('refuses what a person cannot set, and the team\'s floor still wins over a person\'s choice', async () => {
        await expect(saveStudioReviewer(repo, { mode_required: false })).rejects.toThrow('not a reviewer setting a person can change: mode_required');
        await expect(saveStudioReviewer(repo, { judges: 4 })).rejects.toThrow('judges is 2 or 3');
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\nreview:\n  reviewer:\n    mode: full\n    panel: required\n');
        const view = await saveStudioReviewer(repo, { panel: false });
        expect(view.teamFile).toBe(true);
        expect(view.effective).toMatchObject({ panel: true, required: { panel: true } });
        expect(view.effective.refused).toEqual(['panel off (user) refused: rigour.yml sets review.reviewer.panel: required']);
    });

    it('dismisses only with a finding id and a reason', async () => {
        await expect(dismissFromStudio(repo, { id: 'nope', reason: 'whatever it is' })).rejects.toThrow('reviewer finding id');
        await expect(dismissFromStudio(repo, { id: 'abcdef0123', reason: 'no' })).rejects.toThrow('say why');
        await expect(dismissFromStudio(repo, { id: 'abcdef0123', reason: 'the lock is one level up' })).rejects.toThrow('no open reviewer finding abcdef0123 on feature');
    });

    it('edits the team\'s rigour.yml in place, comments kept, and shows the diff to commit', async () => {
        const yml = '# Team gates\nversion: 1\nreview:\n  reviewer:\n    # agreed in the retro\n    mode: single\n';
        fs.writeFileSync(path.join(repo, 'rigour.yml'), yml);
        execFileSync('git', ['-C', repo, 'add', 'rigour.yml']);
        execFileSync('git', ['-C', repo, 'commit', '-qm', 'team config']);
        const view = await saveTeamReviewer(repo, { patch: { mode: 'full', panel: 'required', judges: 3 } });
        const after = fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8');
        expect(after).toContain('# Team gates');
        expect(after).toContain('# agreed in the retro');
        expect(after).toMatch(/mode: full[\s\S]*panel: required[\s\S]*judges: 3/);
        expect(view.diff).toContain('-    mode: single');
        expect(view.diff).toContain('+    panel: required');
        expect(view.effective).toMatchObject({ mode: 'full', panel: true, judges: 3, required: { panel: true } });
        await saveTeamReviewer(repo, { patch: { judges: null } });
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).not.toContain('judges');
    });

    it('refuses a team write that would break rigour.yml, touches other sections, or creates the file unasked', async () => {
        await expect(saveTeamReviewer(repo, { patch: { mode: 'full' } })).rejects.toThrow('there is no rigour.yml');
        expect(fs.existsSync(path.join(repo, 'rigour.yml'))).toBe(false);
        const created = await saveTeamReviewer(repo, { patch: { enabled: true }, create: true });
        expect(created.teamFile).toBe(true);
        expect(created.diff).toContain('+version: 1');
        await expect(saveTeamReviewer(repo, { patch: { gates: {} } })).rejects.toThrow('not a team reviewer setting: gates');
        await expect(saveTeamReviewer(repo, { patch: { judges: 7 } })).rejects.toThrow('that would not be a valid rigour.yml');
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).not.toContain('judges');
    });

    it('refuses a linked rigour.yml and a model name a CLI would read as a flag', async () => {
        const elsewhere = path.join(home, 'elsewhere.yml');
        fs.writeFileSync(elsewhere, 'version: 1\n');
        fs.symlinkSync(elsewhere, path.join(repo, 'rigour.yml'));
        await expect(saveTeamReviewer(repo, { patch: { enabled: true } })).rejects.toThrow('rigour.yml is a link');
        expect(fs.readFileSync(elsewhere, 'utf8')).toBe('version: 1\n');
        await expect(saveStudioReviewer(repo, { models: { claude: '--dangerously-skip-permissions' } })).rejects.toThrow('not starting with -');
    });
});

