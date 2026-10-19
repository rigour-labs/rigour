import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backtestJudgeHomes, judgeIsolation, judgesUnderProfile, withJudgeHome } from './judge-isolation.js';
import { ADAPTERS } from './adapters.js';

let home: string;
const profile = { name: 'synthetic-co', match: ['~/work/synthetic-co'] };
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-isolation-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A Codex home holding `entries` (synthetic content: never a real one). */
function codexHome(dir: string, entries: string[]): string {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
        if (entry === 'memories') fs.mkdirSync(path.join(dir, entry));
        else fs.writeFileSync(path.join(dir, entry), '# synthetic\n');
    }
    return dir;
}

describe('the codex judge under a profile', () => {
    it("is skipped, with the directory and the fix, when the shared Codex home holds config.toml, AGENTS.md or memories", () => {
        for (const entry of ['config.toml', 'AGENTS.md', 'memories']) {
            const dir = codexHome(path.join(home, entry, '.codex'), [entry]);
            const isolation = judgeIsolation('codex', profile, path.dirname(dir), {});
            expect(isolation.skip).toContain(`codex would read ${dir} (${entry}), shared by every organization on this machine`);
            expect(isolation.skip).toContain('rigour profile add synthetic-co … --codex-home <dir>');
            expect(isolation.skip).toContain('`CODEX_HOME=<dir> codex login`');
            expect(isolation.env).toBeUndefined();
        }
    });

    it('reads CODEX_HOME before ~/.codex, as codex does', () => {
        codexHome(path.join(home, '.codex'), ['AGENTS.md']);
        const elsewhere = codexHome(path.join(home, 'elsewhere'), []);
        expect(judgeIsolation('codex', profile, home, { CODEX_HOME: elsewhere })).toEqual({});
        const shared = codexHome(path.join(home, 'shared'), ['config.toml']);
        expect(judgeIsolation('codex', profile, home, { CODEX_HOME: shared }).skip).toContain(`codex would read ${shared} (config.toml)`);
    });

    it("runs in the profile's own Codex home, whatever the shared one holds", () => {
        codexHome(path.join(home, '.codex'), ['config.toml', 'AGENTS.md']);
        const own = path.join(home, 'synthetic-co-codex');
        expect(judgeIsolation('codex', { ...profile, codexHome: own }, home, {})).toEqual({ env: { CODEX_HOME: own } });
    });

    it('runs as before when the shared Codex home holds only a login, or does not exist', () => {
        codexHome(path.join(home, '.codex'), ['auth.json']);
        expect(judgeIsolation('codex', profile, home, {})).toEqual({});
        expect(judgeIsolation('codex', profile, path.join(home, 'nobody'), {})).toEqual({});
    });

    it('changes nothing without a profile: the record notes what codex reads', () => {
        codexHome(path.join(home, '.codex'), ['config.toml', 'AGENTS.md']);
        expect(judgeIsolation('codex', undefined, home, {})).toEqual({});
        expect(ADAPTERS.codex.outsideRepo!(home, '1.0.0', { CODEX_HOME: path.join(home, '.codex') })).toContain(path.join(home, '.codex', 'config.toml'));
    });

    it("says on the record what codex reads from the profile's own Codex home", () => {
        const own = codexHome(path.join(home, 'own'), ['AGENTS.md']);
        expect(ADAPTERS.codex.outsideRepo!(home, '1.0.0', { CODEX_HOME: own })).toBe(`codex also reads ${path.join(own, 'AGENTS.md')}`);
    });
});

describe('the cursor judge under a profile', () => {
    it('is skipped unless the profile allows it: cursor-agent has no switch that gives a profile its own rules', () => {
        expect(judgeIsolation('cursor', profile, home, {}).skip).toContain('rigour profile add synthetic-co … --cursor-shared');
        expect(judgeIsolation('cursor', { ...profile, cursorShared: true }, home, {})).toEqual({});
        expect(judgeIsolation('cursor', undefined, home, {})).toEqual({});
    });
});

describe("doctor's view of the judges under a profile", () => {
    it('says which run isolated and which are skipped and why', () => {
        codexHome(path.join(home, '.codex'), ['config.toml']);
        const lines = judgesUnderProfile(['claude', 'codex', 'cursor'], profile, home, {});
        expect(lines.map(line => [line.name, line.runs])).toEqual([['claude', true], ['codex', false], ['cursor', false]]);
        expect(lines[0].detail).toContain('isolated');
        expect(lines[1].detail).toContain('--codex-home');
        const own = judgesUnderProfile(['codex', 'cursor'], { ...profile, codexHome: '/synthetic/codex', cursorShared: true }, home, {});
        expect(own.map(line => line.detail)).toEqual(["isolated: this profile's Codex home /synthetic/codex", expect.stringContaining('not isolated')]);
    });
});

describe('a backtest\'s judges', () => {
    it('run codex in a home of their own holding only the login, so today\'s memories and AGENTS.md stay out', () => {
        const shared = codexHome(path.join(home, '.codex'), ['config.toml', 'AGENTS.md', 'memories', 'auth.json']);
        const homes = backtestJudgeHomes(path.join(home, 'backtest'), home, {});
        const codex = homes.codex!.CODEX_HOME;
        expect(fs.readdirSync(codex)).toEqual(['auth.json']);
        expect(fs.realpathSync(path.join(codex, 'auth.json'))).toBe(fs.realpathSync(path.join(shared, 'auth.json')));
        expect(ADAPTERS.codex.outsideRepo!(home, undefined, homes.codex)).toBeUndefined();
        expect(ADAPTERS.codex.outsideRepo!(home, undefined, {})).toContain('AGENTS.md'); // what a live review reads, said on its record
        expect(backtestJudgeHomes(path.join(home, 'backtest'), home, {})).toEqual(homes); // made once, reused
        expect(homes.cursor).toBeUndefined(); // no switch exists: its record says what it read
    });

    it('defer to a profile\'s own isolation, and leave a live review as it was', () => {
        const backtest = { CODEX_HOME: '/tmp/backtest-codex' };
        expect(withJudgeHome({}, backtest)).toEqual({ env: backtest });
        expect(withJudgeHome({ env: { CODEX_HOME: '/profile' } }, backtest)).toEqual({ env: { CODEX_HOME: '/profile' } });
        expect(withJudgeHome({ skip: 'not under this profile' }, backtest)).toEqual({ skip: 'not under this profile' });
        expect(withJudgeHome({}, undefined)).toEqual({});
    });
});
