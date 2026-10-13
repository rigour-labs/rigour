/**
 * Windsurf's hooks go where Devin Desktop reads them: `.devin/hooks.json` when it defines hooks, else the legacy
 * `.windsurf/hooks.json`. Synthetic temp repositories only.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hooksInitCommand } from './hooks.js';
import { checkRepoSetup } from './repo-setup.js';
import { uninstall } from './uninstall.js';

vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@rigour-labs/core')>(),
    recordInteractionEvidence: vi.fn().mockResolvedValue(undefined),
    updateAutomaticIndexForFiles: vi.fn().mockResolvedValue(undefined),
}));

const PERSON_HOOK = { command: 'node scripts/format-on-write.js' };
let repo: string;
let logged: string[];
const file = (rel: string) => path.join(repo, rel);
const write = (rel: string, value: unknown) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), JSON.stringify(value, null, 4) + '\n'); };
const read = (rel: string) => JSON.parse(fs.readFileSync(file(rel), 'utf8'));
const commands = (rel: string, event: string) => (read(rel).hooks[event] ?? []).map((h: { command: string }) => h.command);
const setUp = () => hooksInitCommand(repo, { tool: 'windsurf', block: true, dlp: true });
const savedAgentHome = process.env.RIGOUR_AGENT_HOME;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-hooks-'));
    process.env.RIGOUR_AGENT_HOME = path.join(repo, '.agent-home');
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});
afterEach(() => {
    if (savedAgentHome === undefined) delete process.env.RIGOUR_AGENT_HOME; else process.env.RIGOUR_AGENT_HOME = savedAgentHome;
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.restoreAllMocks();
});

describe('Windsurf hooks and Devin Desktop', () => {
    it('writes the legacy file when there is no .devin/hooks.json, and never creates one', async () => {
        fs.mkdirSync(file('.windsurf'));
        await setUp();
        expect(commands('.windsurf/hooks.json', 'post_write_code')[0]).toContain('hooks check --stdin --block');
        expect(fs.existsSync(file('.devin'))).toBe(false);
    });

    it('merges into .devin/hooks.json when it defines hooks, keeping the person\'s hook and indent', async () => {
        write('.devin/hooks.json', { hooks: { post_write_code: [PERSON_HOOK] } });
        await setUp();
        const text = fs.readFileSync(file('.devin/hooks.json'), 'utf8');
        expect(text).toMatch(/\n {4}"hooks"/);
        expect(read('.devin/hooks.json').version).toBeUndefined();
        expect(commands('.devin/hooks.json', 'post_write_code')).toEqual([PERSON_HOOK.command, expect.stringContaining('hooks check --stdin')]);
        expect(commands('.devin/hooks.json', 'pre_write_code')[0]).toContain('--mode dlp');
        expect(fs.existsSync(file('.windsurf/hooks.json'))).toBe(false);
        expect(logged.join('\n')).toContain('MERGE .devin/hooks.json');
        expect(logged.join('\n')).toContain('your other settings kept');
        await setUp(); // a second run changes nothing
        expect(fs.readFileSync(file('.devin/hooks.json'), 'utf8')).toBe(text);
    });

    it('moves Rigour\'s hooks out of the legacy file Devin Desktop ignores, keeping the person\'s entries there', async () => {
        fs.mkdirSync(file('.windsurf'));
        await setUp(); // Rigour's hooks in .windsurf/hooks.json
        const legacy = read('.windsurf/hooks.json');
        legacy.hooks.post_write_code.unshift(PERSON_HOOK);
        write('.windsurf/hooks.json', legacy);
        write('.devin/hooks.json', { hooks: { pre_read_code: [PERSON_HOOK] } });
        const doctor = async () => (await checkRepoSetup(repo, new Date(), [])).find(c => c.id === 'windsurf-file');
        expect(await doctor()).toMatchObject({ state: 'broken', fix: 'rigour setup' });

        await setUp();
        expect(commands('.devin/hooks.json', 'post_write_code')[0]).toContain('hooks check');
        expect(commands('.devin/hooks.json', 'pre_read_code')).toEqual([PERSON_HOOK.command]);
        expect(read('.windsurf/hooks.json').hooks).toEqual({ post_write_code: [PERSON_HOOK] });
        expect(logged.join('\n')).toContain('MOVE Windsurf hooks to .devin/hooks.json');
        expect(await doctor()).toBeUndefined();
        const edit = (await checkRepoSetup(repo, new Date(), [])).find(c => c.id === 'edit');
        expect(edit?.name).toContain('Windsurf (.devin/hooks.json)');
    });

    it('deletes a legacy file Rigour created once its hooks moved to .devin/hooks.json', async () => {
        fs.mkdirSync(file('.windsurf'));
        await setUp();
        write('.devin/hooks.json', { hooks: { pre_read_code: [PERSON_HOOK] } });
        await setUp();
        expect(fs.existsSync(file('.windsurf/hooks.json'))).toBe(false);
    });

    it('keeps writing the legacy file while .devin/hooks.json defines no hooks, since Devin Desktop then reads the legacy one', async () => {
        write('.devin/hooks.json', { hooks: {} });
        await setUp();
        expect(read('.devin/hooks.json')).toEqual({ hooks: {} });
        expect(commands('.windsurf/hooks.json', 'post_write_code')[0]).toContain('hooks check');
    });

    it('uninstall takes Rigour\'s entries out of .devin/hooks.json and keeps the person\'s', async () => {
        write('.devin/hooks.json', { hooks: { post_write_code: [PERSON_HOOK] } });
        await setUp();
        const report = uninstall(repo);
        expect(report.changes).toContain('remove Rigour entries from .devin/hooks.json');
        expect(read('.devin/hooks.json')).toEqual({ hooks: { post_write_code: [PERSON_HOOK] } });
    });
});
