import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { runReviewer, type ReviewerOptions } from '../reviewer.js';
import { ADAPTERS } from './adapters.js';
import { defaultExec } from './exec.js';
import { EMPTY_VERDICT, gitIn, makeRepo, write } from './__tests__/judge-fakes.js';
import { cleanedUp, harnessEnv, inCopy, MACOS_ONLY, ON_MACOS, reviewIn, runCodeConfig, runCodeHarness } from './__tests__/run-code-harness.js';
import { recordLines } from './record.js';
import { copyPool } from './copy-pool.js';
import { judgeRunCodeRefusal, runCodeModel, runInCopy } from './run-code.js';

// Each test runs whole reviews (some several, a failed judge asked twice): under a full suite's load, past 5 s.
vi.setConfig({ testTimeout: 60_000 });
const h = runCodeHarness();
const review = (extra: Record<string, unknown> = {}, options: ReviewerOptions = {}) => reviewIn(h.repo, extra, options);
const GIT_OFF = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_GLOBAL: '/dev/null' };

describe.runIf(ON_MACOS)(`run_code: codex ${MACOS_ONLY}`, () => {
    it('runs codex sandboxed, no network, ignoring every config but the pins, in a standalone throwaway copy of the head', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), scratch: { file: 'scratch.test.mjs', content: 'console.log(1)\n' } });
        const result = await review();
        const [run] = h.judges.runs();
        // Writable besides the copy: only the judge's own temporary base, short (/tmp/rgr-XXXXXX), removed with the copy.
        const tmp = run.env.CLAUDE_CODE_TMPDIR;
        expect(tmp).toMatch(/^\/tmp\/rgr-[A-Za-z0-9]{6}$/);
        expect(fs.existsSync(tmp)).toBe(false);
        const dir = path.join(tmp, `claude-${process.getuid!()}`);
        expect(run.argv.slice(0, 18)).toEqual([
            'exec', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
            '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'approval_policy=never', '-c', 'allow_login_shell=false', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([`/private${tmp}`])}`, '--json',
        ]);
        expect(run.env).toMatchObject({ TMPDIR: dir, TMP: dir, TEMP: dir, GOCACHE: path.join(dir, 'go-build'), GOTMPDIR: dir, GOTELEMETRY: 'off' });
        expect(run.argv.join(' ')).not.toMatch(/read-only|danger|network_access=true/);
        expect(inCopy(run)).toBe(true);
        expect(run.files.sort()).toEqual(['.git', 'a.ts', 'rigour.yml', 'scratch.test.mjs', 'src']); // a checkout of the head, and the judge's scratch file
        const told = /Your working copy\n\((\S+), your current directory\) is a throwaway copy/.exec(run.prompt);
        expect(told?.[1]).toBe(run.cwd); // the copy's real path, as the judge's working directory
        expect(run.prompt).toContain('files you\ncreate are not evidence');
        expect(run.prompt).not.toContain('READ-ONLY');
        cleanedUp(h.repo, [run]);
        expect(fs.existsSync(path.join(h.repo, 'scratch.test.mjs'))).toBe(false);
        expect(result.outcome).toBe('passed');
        expect(result.mode?.ranCode).toEqual(['codex']);
        expect(result.record?.judges[0]).toMatchObject({ reviewer: 'codex', ran_code: true });
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by codex \(ran code in a throwaway copy\) codex-cli 9999\.0\.0/);
    });

    it('works in a copy that is not a worktree of the checkout, so nothing resolves to it: no remote, no alternates, objects hardlinked, never registered', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), scratch: { file: 'copy-facts.txt', content: '' } });
        const seen: string[] = [];
        const result = await runReviewer(h.repo, 'main', runCodeConfig(), async (command, args, options) => {
            const done = await defaultExec(command, args, options);
            if (path.basename(command) === 'codex' && args[0] !== '--version') {
                seen.push(fs.statSync(path.join(options.cwd, '.git')).isDirectory() ? 'own .git directory' : '.git file');
                seen.push(fs.existsSync(path.join(options.cwd, '.git', 'objects', 'info', 'alternates')) ? 'alternates' : 'no alternates');
                const object = gitIn(h.repo, 'rev-parse', 'HEAD').trim();
                const loose = (repo: string) => fs.statSync(path.join(repo, '.git', 'objects', object.slice(0, 2), object.slice(2))).ino;
                seen.push(loose(options.cwd) === loose(h.repo) ? 'objects hardlinked' : 'objects copied');
                seen.push(JSON.parse(fs.readFileSync(path.join(path.dirname(options.cwd), 'owner.json'), 'utf8')).pid === process.pid ? 'owned by this process' : 'owner unknown');
                seen.push(gitIn(options.cwd, 'remote').trim() || 'no remote');
                seen.push(gitIn(options.cwd, 'rev-parse', 'HEAD') === gitIn(h.repo, 'rev-parse', 'HEAD') ? 'at the head' : 'elsewhere');
            }
            return done;
        }, () => undefined, { blind: true, force: true });
        expect(result.outcome).toBe('passed');
        expect(seen).toEqual(['own .git directory', 'no alternates', 'objects hardlinked', 'owned by this process', 'no remote', 'at the head']);
        expect(fs.existsSync(path.join(h.repo, '.git', 'worktrees'))).toBe(false); // never registered as a worktree
    });

    it('loads no .codex/config.toml the reviewed commit carries: the user config (and its project trust) and rules are ignored, the sandbox keys pinned', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        h.made.push(outside);
        write(h.repo, { '.codex/config.toml': `[sandbox_workspace_write]\nwritable_roots = ["${outside}"]\nnetwork_access = true\n[shell_environment_policy]\nset = { HOSTILE_MARK = "loaded" }\n` });
        gitIn(h.repo, 'add', '-A');
        gitIn(h.repo, 'commit', '-qm', 'hostile codex config');
        await review();
        const [run] = h.judges.runs();
        expect(run.argv).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', `sandbox_workspace_write.writable_roots=${JSON.stringify([`/private${run.env.CLAUDE_CODE_TMPDIR}`])}`, 'sandbox_workspace_write.network_access=false']));
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

describe.runIf(ON_MACOS)(`run_code: a repository that borrows its objects ${MACOS_ONLY}`, () => {
    it('is copied whole (--dissociate): the copy has no alternates file, so nothing leads back', async () => {
        const borrower = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-switches-')));
        h.made.push(borrower);
        gitIn(h.repo, 'clone', '--quiet', '--shared', h.repo, borrower);
        expect(fs.existsSync(path.join(borrower, '.git', 'objects', 'info', 'alternates'))).toBe(true);
        gitIn(borrower, 'checkout', '-q', 'feature');
        let alternates: boolean | undefined;
        await runReviewer(borrower, 'origin/main', runCodeConfig(), async (command, args, options) => {
            if (path.basename(command) === 'codex' && args[0] !== '--version') alternates = fs.existsSync(path.join(options.cwd, '.git', 'objects', 'info', 'alternates'));
            return defaultExec(command, args, options);
        }, () => undefined, { blind: true, force: true });
        expect(alternates).toBe(false);
    });
});

describe.runIf(ON_MACOS)(`run_code: codex keeps the person's model ${MACOS_ONLY}`, () => {
    const config = (model: string) => [
        `model = "${model}"`, 'model_provider = "acme"', 'approval_policy = "on-request"', '',
        '[model_providers.acme]', 'name = "Acme"', 'base_url = "https://llm.example.com/v1" # the gateway', 'env_key = "ACME_API_KEY"', '',
        '[mcp_servers.tools]', 'command = "example-tool"', '',
    ].join('\n');

    it("from its home's config.toml: model and provider as overrides, nothing else; the provider's key kept; the record names the model", async () => {
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), config('acme-large'));
        harnessEnv.set({ ACME_API_KEY: 'k', OTHER_API_KEY: 'k' });
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT) });
        const result = await review();
        const [run] = h.judges.runs();
        const overrides = run.argv.flatMap((arg, i) => (arg === '-c' ? [run.argv[i + 1]] : [])).filter(value => /^model/.test(value));
        expect(overrides).toEqual(['model="acme-large"', 'model_provider="acme"', 'model_providers.acme.name="Acme"', 'model_providers.acme.base_url="https://llm.example.com/v1"', 'model_providers.acme.env_key="ACME_API_KEY"', 'model_reasoning_effort=high']);
        expect(run.argv.join(' ')).not.toMatch(/mcp_servers|on-request/);
        expect(run.argv).toContain('--ignore-user-config');
        expect([run.env.ACME_API_KEY, run.env.OTHER_API_KEY]).toEqual(['k', undefined]);
        expect(result.record?.judges[0]).toMatchObject({ reviewer: 'codex', ran_code: true, model: 'acme-large' });
    });

    it('passes no other provider key, and refuses run_code for codex when its provider carries credentials', async () => {
        const secretHeader = ['x-example', 'auth: s3cr3t-header-value'].join('-');
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), [
            'model = "acme-large"', 'model_provider = "acme"', '', '[model_providers.acme]', 'base_url = "https://llm.example.com/v1"', 'request_max_retries = 4', 'wire_api = "responses"',
            `http_headers = { "${secretHeader}" = "1" }`, '',
        ].join('\n'));
        const result = await review();
        const [run] = h.judges.runs();
        expect(run.argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
        expect(run.argv.join(' ')).not.toContain('s3cr3t');
        expect(result.mode?.caveats).toContain("run_code: codex's provider config carries credentials Rigour won't put on a command line; codex stays read-only");
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), ['model = "acme-large"', 'model_provider = "acme"', '', '[model_providers.acme]', 'base_url = "https://llm.example.com/v1"', 'request_max_retries = 4', 'wire_api = "responses"', ''].join('\n'));
        await review();
        const overrides = h.judges.runs()[1].argv.flatMap((arg, i, all) => (arg === '-c' ? [all[i + 1]] : [])).filter(value => /^model_provider/.test(value));
        expect(overrides).toEqual(['model_provider="acme"', 'model_providers.acme.base_url="https://llm.example.com/v1"', 'model_providers.acme.wire_api="responses"']);
    });

    for (const url of ['https://dev-a:pw@llm.example.com/v1', 'https://llm.example.com/v1?api-key=k', 'https://llm.example.com/v1?sig=abc&x=1']) {
        it(`keeps codex read-only when its provider's base_url carries a credential: ${url.replace(/\/\/.*@/, '//…@')}`, async () => {
            fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), ['model_provider = "acme"', '[model_providers.acme]', `base_url = "${url}"`, ''].join('\n'));
            const result = await review();
            expect(h.judges.runs()[0].argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
            expect(h.judges.runs()[0].argv.join(' ')).not.toContain(url);
            expect(result.mode?.caveats).toContain("run_code: codex's provider config carries credentials Rigour won't put on a command line; codex stays read-only");
        });
    }

    it("from a profile's own Codex home, when the judge runs with one", async () => {
        const profileHome = path.join(h.homes, 'profile-codex');
        fs.mkdirSync(profileHome);
        fs.writeFileSync(path.join(profileHome, 'config.toml'), config('profile-model'));
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), 'model = "machine-model"\n');
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT) });
        const pool = copyPool(h.repo, gitIn(h.repo, 'rev-parse', 'HEAD').trim(), defaultExec);
        const run = { binary: path.join(h.judges.dir, 'codex'), name: 'codex' as const, version: '9999.0.0', prompt: 'review', model: undefined, timeoutMs: 30_000, unset: [], env: { CODEX_HOME: profileHome } };
        await runInCopy(pool, h.repo, defaultExec, run);
        pool.close();
        expect(h.judges.runs()[0].argv).toEqual(expect.arrayContaining(['model="profile-model"']));
        expect(h.judges.runs()[0].argv).not.toContain('model="machine-model"');
        expect(runCodeModel(run)).toBe('profile-model');
    });
});

describe.runIf(ON_MACOS)(`run_code: claude ${MACOS_ONLY}`, () => {
    it('runs claude restricted to no settings file, sandboxed with no network, no escape, the credential files unreadable and other sessions\' temp files unwritable', async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tmp-base-'));
        h.made.push(tmpBase);
        const session = path.join(tmpBase, `claude-${process.getuid!()}`, 'other-session');
        fs.mkdirSync(session, { recursive: true });
        harnessEnv.set({ CLAUDE_CODE_TMPDIR: tmpBase });
        const result = await review({ reviewers: ['claude'] });
        const [run] = h.judges.runs();
        expect(run.argv).toContain('--restricted');
        expect(run.argv).not.toContain('--setting-sources');
        const settings = JSON.parse(run.argv[run.argv.indexOf('--settings') + 1]);
        expect(settings).toMatchObject({ hooks: {}, outputStyle: 'default', sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } } });
        // The whole home is denied and only the copy, the temporary directory and toolchains read back; the person's .git is denied.
        const home = fs.realpathSync(os.homedir());
        // /tmp too: other judges' temporary bases (/tmp/rgr-*) and Claude Code's shared /tmp/claude-<uid> are there.
        expect(settings.sandbox.filesystem.denyRead).toEqual([home, fs.realpathSync(os.tmpdir()), fs.realpathSync('/tmp'), path.join(fs.realpathSync(h.repo), '.git')]);
        expect(settings.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining([run.cwd]));
        expect(settings.sandbox.filesystem.allowRead).not.toContain(fs.realpathSync(os.tmpdir())); // not the whole temporary directory
        expect(settings.sandbox.filesystem.allowRead.filter((p: string) => p.startsWith(fs.realpathSync(os.tmpdir())))).toEqual([run.cwd, expect.stringMatching(/\/rigour-reviewer-[A-Za-z0-9]+$/)]);
        // Its own temporary base: short, so Claude Code gives its commands TMPDIR there, not the shared /tmp/claude-<uid>.
        expect(run.env.CLAUDE_CODE_TMPDIR).toMatch(/^\/tmp\/rgr-[A-Za-z0-9]{6}$/);
        expect(`${run.env.CLAUDE_CODE_TMPDIR}/claude-${process.getuid!()}`.length).toBeLessThanOrEqual(30);
        expect(run.env.TMPDIR).toBe(`${run.env.CLAUDE_CODE_TMPDIR}/claude-${process.getuid!()}`);
        expect(settings.sandbox.filesystem.allowRead).toContain(`/private${run.env.CLAUDE_CODE_TMPDIR}`);
        for (const allowed of settings.sandbox.filesystem.allowRead) expect(allowed.startsWith(home) ? /\/(\.nvm|\.volta|\.asdf|\.pyenv|\.rbenv|\.rustup|\.cargo\/bin|go\/(bin|pkg\/mod)|\.bun\/bin|\.deno\/bin|\.local\/bin|Library\/pnpm|\.npm\/_cacache|\.npm\/_npx)$/.test(allowed) : true, allowed).toBe(true);
        expect(settings.sandbox.filesystem.denyWrite).toEqual([fs.realpathSync(session), path.join(run.cwd, '.git')]);
        expect(run.argv.slice(run.argv.indexOf('--allowedTools') + 1, run.argv.indexOf('--disallowedTools'))).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
        expect(run.argv.slice(run.argv.indexOf('--disallowedTools') + 1)).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
        expect(run.argv).toEqual(expect.arrayContaining(['--strict-mcp-config']));
        expect(run.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', ...GIT_OFF });
        expect(inCopy(run)).toBe(true);
        cleanedUp(h.repo, [run]);
        expect(recordLines(result.record!).join('\n')).toMatch(/Judged by claude \(ran code in a sandboxed throwaway copy\) 9999\.0\.0/);
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    it('tells a key-only person to sign in when run_code took the key and the judge could not log in', async () => {
        harnessEnv.set({ ANTHROPIC_API_KEY: 'example-key', OPENAI_API_KEY: 'example-key' });
        h.judges.behave({ exitCode: 1, answer: 'Not logged in · Please run /login' });
        expect((await review({ reviewers: ['claude'] })).reason).toContain("run_code removed ANTHROPIC_API_KEY from the judge's environment; sign in with `claude` instead");
        h.judges.behave({ exitCode: 1, answer: '401 Unauthorized' });
        expect((await review()).reason).toContain("run_code removed OPENAI_API_KEY from the judge's environment; sign in with `codex login` instead");
    });
});

describe('run_code read from the base', () => {
    it('a branch that turns run_code on in its own rigour.yml gets a read-only review that says where run_code is read from', async () => {
        for (const [base, says] of [[{}, 'which has no rigour.yml'], [{ 'rigour.yml': 'version: 1\n' }, 'where it is off']] as const) {
            const repo = makeRepo(base, { 'rigour.yml': 'version: 1\nreview:\n  reviewer:\n    run_code: "on"\n' });
            h.made.push(repo);
            const result = await reviewIn(repo);
            const mergeBase = gitIn(repo, 'merge-base', 'main', 'HEAD').trim().slice(0, 9);
            expect(h.judges.runs().at(-1)!.argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
            expect(result.mode?.ranCode).toBeUndefined();
            expect(result.mode?.caveats).toContain(`run_code refused: run_code is read from ${mergeBase}, ${says}; every judge stays read-only`);
        }
    });

    it('a branch that turns it off is reviewed read-only, without a word: off is the default', async () => {
        const result = await reviewIn(h.repo, { run_code: 'off' });
        expect(h.judges.runs().at(-1)!.argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
        expect(result.mode?.caveats ?? []).toEqual([]);
    });
});

describe('run_code refused', () => {
    it('stays read-only below the Claude Code version, and on a platform, its sandbox was verified on', () => {
        expect(ADAPTERS.claude.runCodeRefusal('2.1.285 (Claude Code)')).toBe(process.platform === 'darwin' ? undefined : `its sandbox is verified on macOS only, and this is ${process.platform}`);
        expect(judgeRunCodeRefusal('claude', '2.1.200 (Claude Code)')).toMatch(/^run_code: its sandbox is verified on (Claude Code 2\.1\.285 or later, and this is 2\.1\.200 \(Claude Code\)|macOS only, and this is \w+); claude stays read-only$/);
    });

    it(`off macOS (here: ${process.platform === 'darwin' ? 'linux, stubbed' : process.platform}): every judge stays read-only and says why`, async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const offMacos = process.platform === 'darwin' ? 'linux' : process.platform;
        Object.defineProperty(process, 'platform', { ...platform, value: offMacos });
        try {
            for (const judge of ['codex', 'claude']) {
                const result = await reviewIn(h.repo, { reviewers: [judge] });
                const run = h.judges.runs().at(-1)!;
                expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(h.repo)); // in the checkout: no copy is made
                expect(run.argv).toEqual(expect.arrayContaining(judge === 'codex' ? ['--sandbox', 'read-only'] : ['--setting-sources', 'project']));
                expect(result.mode?.ranCode).toBeUndefined();
                expect(result.mode?.caveats).toContain(`run_code: its sandbox is verified on macOS only, and this is ${offMacos}; ${judge} stays read-only`);
            }
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
    });

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
