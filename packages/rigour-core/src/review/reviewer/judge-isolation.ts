/**
 * What a judge may read from this machine under a profile (utils/profile.ts: one machine, many organizations, nothing
 * crosses). The claude judge is isolated by its own switches (adapters.ts). Codex reads its home (CODEX_HOME, else
 * ~/.codex): its config.toml, which can name MCP servers, AGENTS.md and memories. A profile with its own Codex home
 * runs codex there; one without it, on a machine whose shared Codex home holds any of those, does not run codex at all.
 * cursor-agent reads ~/.cursor's rules, MCP servers and hooks, and the account's own rules, whatever CURSOR_CONFIG_DIR
 * says: no switch gives a profile its own, so under a profile it runs only when the profile allows it.
 *
 * With no profile nothing changes: what a judge reads outside the repository is said on the record (outsideRepo).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandHome, type RigourProfile } from '../../utils/profile.js';
import type { ReviewerName } from './adapters.js';

export interface JudgeIsolation {
    /** Variables the judge runs with under this profile, on top of the adapter's own. */
    env?: Record<string, string>;
    /** Why the judge does not run under this profile, and how to let it: never a pass, the judge is unavailable. */
    skip?: string;
}

/** What in a Codex home carries a person's instructions or tools, rather than only their login. */
const CODEX_SHARED = ['config.toml', 'AGENTS.md', 'memories'];

export function judgeIsolation(name: ReviewerName, profile: RigourProfile | undefined, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): JudgeIsolation {
    if (!profile) return {};
    if (name === 'codex') return codexIsolation(profile, home, env);
    if (name === 'cursor' && !profile.cursorShared) {
        return { skip: `cursor reads your own Cursor rules, MCP servers and settings (~/.cursor and your Cursor account), shared by every organization on this machine, and has no switch to give a profile its own; to run it under this profile anyway: rigour profile add ${profile.name} … --cursor-shared (with its other options)` };
    }
    return {};
}

function codexIsolation(profile: RigourProfile, home: string, env: NodeJS.ProcessEnv): JudgeIsolation {
    if (profile.codexHome) return { env: { CODEX_HOME: expandHome(profile.codexHome) } };
    const dir = env.CODEX_HOME?.trim() || path.join(home, '.codex');
    const shared = CODEX_SHARED.filter(entry => fs.existsSync(path.join(dir, entry)));
    if (shared.length === 0) return {};
    return { skip: `codex would read ${dir} (${shared.join(', ')}), shared by every organization on this machine; set this profile's Codex home: rigour profile add ${profile.name} … --codex-home <dir> (with its other options), then \`CODEX_HOME=<dir> codex login\`` };
}

/** Each judge under `profile`, for doctor: which run isolated, which are skipped and why. */
export function judgesUnderProfile(names: ReviewerName[], profile: RigourProfile, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Array<{ name: ReviewerName; runs: boolean; detail: string }> {
    return names.map(name => {
        const isolation = judgeIsolation(name, profile, home, env);
        if (isolation.skip) return { name, runs: false, detail: isolation.skip };
        if (name === 'claude') return { name, runs: true, detail: 'isolated: no MCP servers, project settings only, no CLAUDE.md or auto-memory' };
        if (name === 'codex') return { name, runs: true, detail: isolation.env ? `isolated: this profile's Codex home ${isolation.env.CODEX_HOME}` : 'the Codex home holds no config.toml, AGENTS.md or memories' };
        if (name === 'cursor') return { name, runs: true, detail: 'not isolated: reads your own Cursor rules and settings, which this profile allows (--cursor-shared)' };
        return { name, runs: true, detail: 'a model API: reads only what Rigour sends it' };
    });
}

/** The judges' own variables for a backtest: codex in a home holding only the login, so no memories or AGENTS.md of today reach a past review. */
export type JudgeHomes = Partial<Record<ReviewerName, Record<string, string>>>;

/** A backtest's judge homes, and the judges it could not give one, each with why. */
export interface BacktestJudges { homes: JudgeHomes; notIsolated: Array<{ judge: ReviewerName; why: string }> }

/**
 * A Codex home for a backtest under `dir`: a link to the login (auth.json) of the home codex uses otherwise, and from
 * that home's config.toml only which model and provider to use (model, model_provider, [model_providers.*]); never its
 * memories, instructions or AGENTS.md. With no auth.json to carry (a keyring login), codex runs in its own home and the
 * round says so. Cursor has no such switch (see above): its review record says what it read.
 */
export function backtestJudgeHomes(dir: string, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): BacktestJudges {
    const source = env.CODEX_HOME?.trim() || path.join(home, '.codex');
    const login = path.join(source, 'auth.json');
    if (!fs.existsSync(login)) return { homes: {}, notIsolated: [{ judge: 'codex', why: 'no auth file to carry' }] };
    try {
        const codexHome = path.join(dir, 'codex-home');
        fs.mkdirSync(codexHome, { recursive: true });
        const link = path.join(codexHome, 'auth.json');
        if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(login, link);
        const settings = modelSettings(readText(path.join(source, 'config.toml')));
        const config = path.join(codexHome, 'config.toml');
        if (settings) fs.writeFileSync(config, settings, { mode: 0o600 });
        else fs.rmSync(config, { force: true });
        return { homes: { codex: { CODEX_HOME: codexHome } }, notIsolated: [] };
    } catch (error) {
        return { homes: {}, notIsolated: [{ judge: 'codex', why: `its backtest home could not be made: ${error instanceof Error ? error.message : String(error)}` }] };
    }
}

function readText(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/** From a config.toml, only the model and provider: the top-level `model` and `model_provider`, and `[model_providers.*]` tables. */
function modelSettings(toml: string): string {
    const kept: string[] = [];
    let table: string | undefined;
    for (const line of toml.split(/\r?\n/)) {
        const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/.exec(line)?.[1];
        if (header !== undefined) table = header;
        const keep = table === undefined ? /^\s*(model|model_provider)\s*=/.test(line) : /^model_providers(\.|$)/.test(table);
        if (keep) kept.push(line);
    }
    return kept.length ? `${kept.join('\n')}\n` : '';
}

/** A profile's isolation wins; a judge it leaves as it is runs with the backtest's home when there is one. */
export function withJudgeHome(isolation: JudgeIsolation, home: Record<string, string> | undefined): JudgeIsolation {
    return isolation.skip || isolation.env || !home ? isolation : { env: home };
}
