import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { runReviewer, type ReviewerOptions } from '../reviewer.js';
import { ADAPTERS } from './adapters.js';
import { defaultExec } from './exec.js';
import { EMPTY_VERDICT, gitIn, write } from './__tests__/judge-fakes.js';
import { cleanedUp, harnessEnv, inCopy, reviewIn, runCodeConfig, runCodeHarness } from './__tests__/run-code-harness.js';
import { recordLines } from './record.js';
import { judgeRunCodeRefusal } from './run-code.js';

// Each test runs whole reviews (some several, a failed judge asked twice): under a full suite's load, past 5 s.
vi.setConfig({ testTimeout: 60_000 });
const h = runCodeHarness();
const review = (extra: Record<string, unknown> = {}, options: ReviewerOptions = {}) => reviewIn(h.repo, extra, options);
const GIT_OFF = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };

describe('run_code: codex', () => {
    it('runs codex sandboxed, no network, ignoring every config but the pins, in a standalone throwaway copy of the head', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), scratch: { file: 'scratch.test.mjs', content: 'console.log(1)\n' } });
        const result = await review();
        const [run] = h.judges.runs();
        expect(run.argv.slice(0, 16)).toEqual([
            'exec', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
            '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'approval_policy=never', '--json',
        ]);
        expect(run.argv.join(' ')).not.toMatch(/read-only|danger|network_access=true/);
        expect(inCopy(run)).toBe(true);
        expect(run.files.sort()).toEqual(['.git', 'a.ts', 'scratch.test.mjs', 'src']); // a checkout of the head, and the judge's scratch file
        const told = /Your working copy\n\((\S+), your current directory\) is a throwaway copy/.exec(run.prompt);
        expect(told && path.join(fs.realpathSync(path.dirname(told[1])), path.basename(told[1]))).toBe(run.cwd);
        expect(run.prompt).toContain('files you\ncreate are not evidence');
        expect(run.prompt).not.toContain('READ-ONLY');
        cleanedUp(h.repo, [run]);
        expect(fs.existsSync(path.join(h.repo, 'scratch.test.mjs'))).toBe(false);
        expect(result.outcome).toBe('passed');
        expect(result.mode?.ranCode).toEqual(['codex']);
        expect(result.record?.judges[0]).toMatchObject({ reviewer: 'codex', ran_code: true });
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by codex \(ran code in a throwaway copy\) codex-cli 9999\.0\.0/);
    });

    it('works in a copy that is not a worktree of the checkout, so nothing resolves to it: no remote, objects shared, never registered', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), scratch: { file: 'copy-facts.txt', content: '' } });
        const seen: string[] = [];
        const result = await runReviewer(h.repo, 'main', runCodeConfig(), async (command, args, options) => {
            const done = await defaultExec(command, args, options);
            if (path.basename(command) === 'codex' && args[0] !== '--version') {
                seen.push(fs.statSync(path.join(options.cwd, '.git')).isDirectory() ? 'own .git directory' : '.git file');
                seen.push(fs.readFileSync(path.join(options.cwd, '.git', 'objects', 'info', 'alternates'), 'utf8').trim() === fs.realpathSync(path.join(h.repo, '.git', 'objects')) ? 'shares the objects' : 'other objects');
                seen.push(gitIn(options.cwd, 'remote').trim() || 'no remote');
                seen.push(gitIn(options.cwd, 'rev-parse', 'HEAD') === gitIn(h.repo, 'rev-parse', 'HEAD') ? 'at the head' : 'elsewhere');
            }
            return done;
        }, () => undefined, { blind: true, force: true });
        expect(result.outcome).toBe('passed');
        expect(seen).toEqual(['own .git directory', 'shares the objects', 'no remote', 'at the head']);
        expect(fs.existsSync(path.join(h.repo, '.git', 'worktrees'))).toBe(false); // never registered as a worktree
    });

    it('loads no .codex/config.toml the reviewed commit carries: the user config (and its project trust) and rules are ignored, the sandbox keys pinned', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        write(h.repo, { '.codex/config.toml': `[sandbox_workspace_write]\nwritable_roots = ["${outside}"]\nnetwork_access = true\n[shell_environment_policy]\nset = { HOSTILE_MARK = "loaded" }\n` });
        gitIn(h.repo, 'add', '-A');
        gitIn(h.repo, 'commit', '-qm', 'hostile codex config');
        await review();
        const [run] = h.judges.runs();
        expect(run.argv).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.network_access=false']));
        expect(run.files).toContain('.codex'); // the copy has the file; codex is told not to load it
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('gives the judge no secret-looking variable, no git credential helper or prompt, and keeps its own login', async () => {
        const secrets = {
            EXAMPLE_API_KEY: 'k', DEPLOY_TOKEN: 't', SIGNING_SECRET: 's', DB_PASSWORD: 'p', SMTP_PASSWD: 'p', CLOUD_CREDENTIAL: 'c', ACME_PAT: 'p', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
            DATABASE_URL: 'postgres://app@db.example.com/app', CACHE_URL: 'redis://user:pw@cache.example.com', AWS_REGION: 'us-east-1', GH_HOST: 'github.example.com', GITHUB_TOKEN: 'g', NPM_TOKEN: 'n', NODE_AUTH_TOKEN: 'n',
            SSH_AUTH_SOCK: '/tmp/agent.sock', KUBECONFIG: '/k', DOCKER_HOST: 'tcp://d', GOOGLE_APPLICATION_CREDENTIALS: '/g.json', CLAUDE_CODE_OAUTH_TOKEN: 'o',
        };
        harnessEnv.set({ ...secrets, DOCS_URL: 'https://docs.example.com', CODEX_HOME: '/tmp/codex-home-example' });
        await review();
        await review({ reviewers: ['claude'] });
        const [codex, claude] = h.judges.runs();
        for (const name of Object.keys(secrets)) expect(codex.env[name], name).toBeUndefined();
        expect(codex.env).toMatchObject({ DOCS_URL: 'https://docs.example.com', CODEX_HOME: '/tmp/codex-home-example', ...GIT_OFF });
        expect(claude.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'o', ...GIT_OFF }); // claude's own login stays
        expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('never verifies a quote from what the judge wrote in its copy: quotes are read from the checkout', async () => {
        const finding = (file: string, line: number, quote: string) => ({ class: 'correctness', severity: 'blocking', file, line, issue: `${quote} misbehaves`, why: 'x', input: 'two runs', consequence: 'two emails', quote });
        h.judges.behave({
            // The judge rewrote src/job.ts in its copy and quotes the rewrite, quotes a scratch file, and quotes the real code.
            scratch: { file: 'src/job.ts', content: 'export function job() {\n    const evil = 1;\n}\n' },
            answer: JSON.stringify({ ...EMPTY_VERDICT, findings: [finding('src/job.ts', 2, 'const evil = 1;'), finding('scratch.test.mjs', 1, 'console.log(1)'), finding('src/job.ts', 2, 'return 1;')] }),
        });
        const result = await review();
        expect(result.items.map(item => item.quote)).toEqual(['return 1;']);
        expect(result.unverified.map(item => item.quote).sort()).toEqual(['console.log(1)', 'const evil = 1;']);
    });
});

describe('run_code: claude', () => {
    it('runs claude restricted to no settings file, sandboxed with no network, no escape, the credential files unreadable and other sessions\' temp files unwritable', async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tmp-base-'));
        const session = path.join(tmpBase, `claude-${process.getuid!()}`, 'other-session');
        fs.mkdirSync(session, { recursive: true });
        harnessEnv.set({ CLAUDE_CODE_TMPDIR: tmpBase });
        const result = await review({ reviewers: ['claude'] });
        const [run] = h.judges.runs();
        expect(run.argv).toContain('--restricted');
        expect(run.argv).not.toContain('--setting-sources');
        const settings = JSON.parse(run.argv[run.argv.indexOf('--settings') + 1]);
        expect(settings).toMatchObject({ hooks: {}, outputStyle: 'default', sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } } });
        const home = os.homedir();
        expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['.ssh', '.aws', '.npmrc', '.netrc', '.config/gh', '.docker', '.kube', '.gnupg', 'Library/Keychains', '.git-credentials', '.config/git/credentials', '.claude/.credentials.json'].map(p => path.join(home, p))));
        expect(settings.sandbox.filesystem.denyWrite).toEqual([fs.realpathSync(session)]);
        expect(run.argv.slice(run.argv.indexOf('--allowedTools') + 1, run.argv.indexOf('--disallowedTools'))).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
        expect(run.argv.slice(run.argv.indexOf('--disallowedTools') + 1)).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
        expect(run.argv).toEqual(expect.arrayContaining(['--strict-mcp-config']));
        expect(run.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', ...GIT_OFF });
        expect(inCopy(run)).toBe(true);
        cleanedUp(h.repo, [run]);
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by claude \(ran code in a sandboxed throwaway copy\) 9999\.0\.0/);
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    it('stays read-only below the Claude Code version, and on a platform, its sandbox was verified on', () => {
        expect(ADAPTERS.claude.runCodeRefusal('2.1.285 (Claude Code)')).toBe(process.platform === 'darwin' ? undefined : `its sandbox is verified on macOS only, and this is ${process.platform}`);
        expect(judgeRunCodeRefusal('claude', '2.1.200 (Claude Code)')).toMatch(/^run_code: its sandbox is verified on (Claude Code 2\.1\.285 or later, and this is 2\.1\.200 \(Claude Code\)|macOS only, and this is \w+); claude stays read-only$/);
    });

    it('tells a key-only person to sign in when run_code took the key and the judge could not log in', async () => {
        harnessEnv.set({ ANTHROPIC_API_KEY: 'example-key', OPENAI_API_KEY: 'example-key' });
        h.judges.behave({ exitCode: 1, answer: 'Not logged in · Please run /login' });
        expect((await review({ reviewers: ['claude'] })).reason).toContain("run_code removed ANTHROPIC_API_KEY from the judge's environment; sign in with `claude` instead");
        h.judges.behave({ exitCode: 1, answer: '401 Unauthorized' });
        expect((await review()).reason).toContain("run_code removed OPENAI_API_KEY from the judge's environment; sign in with `codex login` instead");
    });
});

describe('run_code refused', () => {
    const readOnly = async (expected: string, extra: Record<string, unknown> = {}, options: ReviewerOptions = {}) => {
        const result = await review(extra, options);
        const run = h.judges.runs().at(-1)!;
        expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(h.repo));
        expect(run.argv.join(' ')).not.toContain('workspace-write');
        expect(result.mode?.ranCode).toBeUndefined();
        expect(result.mode?.caveats).toContain(expected);
        expect(result.record?.caveats).toContain(expected);
        expect(result.record?.judges.some(judge => judge.ran_code)).toBe(false);
    };
    const ci = 'run_code refused: this is CI (a CI variable such as CI or GITHUB_ACTIONS, or --ci); every judge stays read-only';

    it('in CI: any CI service\'s variable (Jenkins, Azure, TeamCity…) and --ci', async () => {
        for (const name of ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION']) {
            harnessEnv.set({ [name]: name === 'JENKINS_URL' ? 'https://ci.example.com' : 'true' });
            await readOnly(ci);
            harnessEnv.set({ [name]: undefined });
        }
        await readOnly(ci, {}, { ci: true });
    });

    it('in an independent review and in a backtest replay', async () => {
        await readOnly("run_code refused: an independent review runs none of the change's code; every judge stays read-only", {}, { independent: true });
        await readOnly("run_code refused: an independent review runs none of the change's code; every judge stays read-only", {}, { trustedRef: gitIn(h.repo, 'rev-parse', 'main') });
        await readOnly('run_code refused: a backtest replays reviews read-only; every judge stays read-only', {}, { trigger: 'backtest' });
    });

    it('for cursor, whose sandbox lets commands write outside the copy: it stays read-only, and says why', async () => {
        await readOnly("run_code: cursor's sandbox lets commands write to /tmp and $TMPDIR outside the throwaway copy, and no switch narrows it; cursor stays read-only", { reviewers: ['cursor'] });
        expect(h.judges.runs()[0].argv).toEqual(expect.arrayContaining(['--mode', 'ask']));
    });
});
