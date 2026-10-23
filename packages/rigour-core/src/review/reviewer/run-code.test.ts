import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { runReviewer, type ReviewerOptions, type ReviewerResult } from '../reviewer.js';
import { ADAPTERS } from './adapters.js';
import { defaultExec } from './exec.js';
import { bigChange, EMPTY_VERDICT, gitIn, installFakeJudges, makeRepo, type FakeJudges, type JudgeRun } from './__tests__/judge-fakes.js';
import { recordLines } from './record.js';
import { judgeRunCodeRefusal } from './run-code.js';
import { VerdictStore } from './store.js';

let repo: string;
let judges: FakeJudges;
const saved: Record<string, string | undefined> = {};
/** What the test sets or clears in this process's environment, restored after. */
function setEnv(values: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(values)) {
        if (!(name in saved)) saved[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}
beforeEach(() => {
    judges = installFakeJudges();
    repo = makeRepo();
    setEnv({ CI: undefined, GITHUB_ACTIONS: undefined }); // the suite may itself run in CI
});
afterEach(() => {
    judges.remove();
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
    for (const name of Object.keys(saved)) delete saved[name];
    fs.rmSync(repo, { recursive: true, force: true });
});

const config = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, review: { coverage: false, reviewer: { enabled: true, reviewers: ['codex'], run_code: 'on', ...extra } } });
const review = (extra: Record<string, unknown> = {}, options: ReviewerOptions = {}): Promise<ReviewerResult> =>
    runReviewer(repo, 'main', config(extra), defaultExec, () => undefined, { blind: true, force: true, ...options });
const worktrees = () => gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;
/** Each run's working copy is gone, and the repository lists no worktree but its own. */
function cleanedUp(runs: JudgeRun[]): void {
    for (const run of runs) expect(fs.existsSync(run.cwd)).toBe(false);
    expect(worktrees()).toBe(1);
}
const copyDir = (run: JudgeRun) => run.cwd.startsWith(fs.realpathSync(os.tmpdir())) && path.basename(run.cwd).startsWith('rigour-judge-copy-');

describe('run_code: codex', () => {
    it('runs codex sandboxed for writes with no network, in a throwaway worktree of the head, removed afterwards', async () => {
        judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), scratch: { file: 'scratch.test.mjs', content: 'console.log(1)\n' } });
        const result = await review();
        const [run] = judges.runs();
        expect(run.argv.slice(0, 9)).toEqual(['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true']);
        expect(run.argv.join(' ')).not.toMatch(/read-only|danger|network_access=true/);
        expect(copyDir(run)).toBe(true);
        expect(run.files.sort()).toEqual(['.git', 'a.ts', 'scratch.test.mjs', 'src']); // a checkout of the head, and the judge's scratch file
        const told = /Your working copy\n\((\S+), your current directory\) is a throwaway copy/.exec(run.prompt);
        expect(told && path.join(fs.realpathSync(path.dirname(told[1])), path.basename(told[1]))).toBe(run.cwd);
        expect(run.prompt).toContain('files you\ncreate are not evidence');
        expect(run.prompt).not.toContain('READ-ONLY');
        cleanedUp([run]);
        expect(fs.existsSync(path.join(repo, 'scratch.test.mjs'))).toBe(false);
        expect(result.outcome).toBe('passed');
        expect(result.mode?.ranCode).toEqual(['codex']);
        expect(result.record?.judges[0]).toMatchObject({ reviewer: 'codex', ran_code: true });
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by codex \(ran code in a throwaway copy\) codex-cli 9999\.0\.0/);
    });

    it('gives the judge none of the secret-looking variables, and keeps its Codex home', async () => {
        setEnv({
            EXAMPLE_API_KEY: 'k', DEPLOY_TOKEN: 't', SIGNING_SECRET: 's', DB_PASSWORD: 'p', SMTP_PASSWD: 'p', CLOUD_CREDENTIAL: 'c', ACME_PAT: 'p',
            DATABASE_URL: 'postgres://app@db.example.com/app', CACHE_URL: 'redis://user:pw@cache.example.com', DOCS_URL: 'https://docs.example.com',
            AWS_REGION: 'us-east-1', GH_HOST: 'github.example.com', GITHUB_TOKEN: 'g', NPM_TOKEN: 'n', NODE_AUTH_TOKEN: 'n', CODEX_HOME: '/tmp/codex-home-example',
        });
        await review();
        const env = judges.runs()[0].env;
        for (const name of ['EXAMPLE_API_KEY', 'DEPLOY_TOKEN', 'SIGNING_SECRET', 'DB_PASSWORD', 'SMTP_PASSWD', 'CLOUD_CREDENTIAL', 'ACME_PAT', 'DATABASE_URL', 'CACHE_URL', 'AWS_REGION', 'GH_HOST', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) expect(env[name], name).toBeUndefined();
        expect(env).toMatchObject({ DOCS_URL: 'https://docs.example.com', CODEX_HOME: '/tmp/codex-home-example' });
        expect(env.PATH).toBeTruthy();
    });

    it('removes the worktree when the judge fails, and when it times out (the judge killed)', async () => {
        judges.behave({ exitCode: 1 });
        expect((await review()).outcome).toBe('unavailable');
        const failed = judges.runs();
        expect(failed).toHaveLength(2); // asked once more: each run its own copy
        expect(new Set(failed.map(run => run.cwd)).size).toBe(2);
        cleanedUp(failed);

        judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), sleepMs: 60_000 });
        const started = Date.now();
        expect((await review({ timeout_ms: 1500 })).outcome).toBe('unavailable');
        expect(Date.now() - started).toBeLessThan(30_000);
        const timedOut = judges.runs().slice(2);
        expect(timedOut.length).toBeGreaterThan(0);
        cleanedUp(timedOut);
        for (const run of timedOut) expect(() => process.kill(run.pid, 0)).toThrow();
    });

    it('never verifies a quote from what the judge wrote in its copy: quotes are read from the checkout', async () => {
        const finding = (file: string, line: number, quote: string) => ({ class: 'correctness', severity: 'blocking', file, line, issue: `${quote} misbehaves`, why: 'x', input: 'two runs', consequence: 'two emails', quote });
        judges.behave({
            // The judge rewrote src/job.ts in its copy and quotes the rewrite, quotes a scratch file, and quotes the real code.
            scratch: { file: 'src/job.ts', content: 'export function job() {\n    const evil = 1;\n}\n' },
            answer: JSON.stringify({ ...EMPTY_VERDICT, findings: [finding('src/job.ts', 2, 'const evil = 1;'), finding('scratch.test.mjs', 1, 'console.log(1)'), finding('src/job.ts', 2, 'return 1;')] }),
        });
        const result = await review();
        expect(result.items.map(item => item.quote)).toEqual(['return 1;']);
        expect(result.unverified.map(item => item.quote).sort()).toEqual(['console.log(1)', 'const evil = 1;']);
    });

    it('gives each orchestrated pass its own worktree, all removed', async () => {
        bigChange(repo, 20);
        (await VerdictStore.open(repo, defaultExec))!.recordCost({ at: new Date().toISOString(), mode: 'orchestrator', lines: 1, projectedSingleChars: 10_000_000, actualChars: 0, actualUsd: 0, runs: 0 });
        const result = await review({ timeout_ms: 60_000 }, { orchestrator: true });
        const runs = judges.runs();
        expect(result.mode?.specialists?.passes.length).toBe(runs.length);
        expect(runs.length).toBeGreaterThan(1);
        expect(new Set(runs.map(run => run.cwd)).size).toBe(runs.length);
        for (const run of runs) expect(copyDir(run)).toBe(true);
        cleanedUp(runs);
    });
});

describe('run_code: claude', () => {
    it('runs claude with its sandbox on, no unsandboxed escape, no network, Bash allowed and the file tools still denied', async () => {
        const result = await review({ reviewers: ['claude'] });
        const [run] = judges.runs();
        const settings = JSON.parse(run.argv[run.argv.indexOf('--settings') + 1]);
        expect(settings).toEqual({ hooks: {}, outputStyle: 'default', sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } } });
        const allowed = run.argv.slice(run.argv.indexOf('--allowedTools') + 1, run.argv.indexOf('--disallowedTools'));
        expect(allowed).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
        expect(run.argv.slice(run.argv.indexOf('--disallowedTools') + 1)).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
        expect(run.argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', 'project']));
        expect(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
        expect(copyDir(run)).toBe(true);
        cleanedUp([run]);
        expect(result.record?.judges[0]).toMatchObject({ reviewer: 'claude', ran_code: true });
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by claude \(ran code in a sandboxed throwaway copy\) 9999\.0\.0/);
    });

    it('stays read-only below the Claude Code version its sandbox was verified on', () => {
        expect(ADAPTERS.claude.runCodeRefusal('2.1.285 (Claude Code)')).toBeUndefined();
        expect(judgeRunCodeRefusal('claude', '2.1.200 (Claude Code)')).toBe('run_code: its sandbox is verified on Claude Code 2.1.285 or later, and this is 2.1.200 (Claude Code); claude stays read-only');
    });
});

describe('run_code refused', () => {
    const readOnly = async (expected: string, extra: Record<string, unknown> = {}, options: ReviewerOptions = {}) => {
        const result = await review(extra, options);
        const run = judges.runs().at(-1)!;
        expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(repo));
        expect(run.argv.join(' ')).not.toContain('workspace-write');
        expect(result.mode?.ranCode).toBeUndefined();
        expect(result.mode?.caveats).toContain(expected);
        expect(result.record?.caveats).toContain(expected);
        expect(result.record?.judges.some(judge => judge.ran_code)).toBe(false);
    };
    const ci = 'run_code refused: this is CI (CI, GITHUB_ACTIONS or --ci); every judge stays read-only';

    it('in CI: the CI and GITHUB_ACTIONS variables and --ci', async () => {
        setEnv({ CI: 'true' });
        await readOnly(ci);
        setEnv({ CI: undefined, GITHUB_ACTIONS: 'true' });
        await readOnly(ci);
        setEnv({ GITHUB_ACTIONS: undefined });
        await readOnly(ci, {}, { ci: true });
    });

    it('in an independent review and in a backtest replay', async () => {
        await readOnly("run_code refused: an independent review runs none of the change's code; every judge stays read-only", {}, { independent: true });
        await readOnly("run_code refused: an independent review runs none of the change's code; every judge stays read-only", {}, { trustedRef: gitIn(repo, 'rev-parse', 'main') });
        await readOnly('run_code refused: a backtest replays reviews read-only; every judge stays read-only', {}, { trigger: 'backtest' });
    });

    it('for cursor, whose sandbox lets commands write outside the copy: it stays read-only, and says why', async () => {
        await readOnly("run_code: cursor's sandbox lets commands write to /tmp and $TMPDIR outside the throwaway copy, and no switch narrows it; cursor stays read-only", { reviewers: ['cursor'] });
        expect(judges.runs()[0].argv).toEqual(expect.arrayContaining(['--mode', 'ask']));
    });
});
