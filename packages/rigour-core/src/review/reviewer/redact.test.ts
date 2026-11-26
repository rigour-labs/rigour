import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { runReviewer } from '../reviewer.js';
import { defaultExec } from './exec.js';
import { EMPTY_VERDICT, gitIn, installFakeJudges, makeRepo, type FakeJudges } from './__tests__/judge-fakes.js';
import { redactDeep, redactRun } from './redact.js';
import { VerdictStore } from './store.js';

/** Synthetic credentials in the shapes the scanner knows, built at run time so no literal sits in the source. */
const TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const KEY = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----'].join('\n');

describe("redacting a judge's output", () => {
    it('replaces each secret with its kind, keeps the JSON parsing, a private key to its END line, and nothing else changes', () => {
        const answer = JSON.stringify({ findings: [{ quote: `token = "${TOKEN}"` }, { quote: '[1, 2]' }] });
        const run = redactRun({ exitCode: 0, stdout: [JSON.stringify({ type: 'result', result: answer }), 'plain', KEY, 'after'].join('\n'), stderr: `failed on ${TOKEN}` });
        const out = { text: run.stdout, count: run.redacted };
        expect(out.count).toBe(3); // two in the output, one in the errors
        expect(run.stderr).toBe('failed on [redacted: github_token]');
        expect(out.text).not.toContain(TOKEN);
        expect(out.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
        const result = JSON.parse(JSON.parse(out.text.split('\n')[0]).result);
        expect(result.findings[0].quote).toBe('token = "[redacted: github_token]"');
        expect(result.findings[1].quote).toBe('[1, 2]'); // a quote that looks like JSON is untouched
        expect(out.text.split('\n').slice(1)).toEqual(['plain', '[redacted: private_key]', 'after']);
        const clean = '{"a": 1}\nno secrets here';
        expect(redactRun({ stdout: clean, stderr: '' })).toEqual({ stdout: clean, stderr: '', redacted: 0 });
    });
});

describe('what is not a secret stays as it is', () => {
    it('an env-style line is redacted only when its name says secret or its value is a token', () => {
        const plain = 'PWD=/var/folders/g_/s9bc0tcs4c93tryjd/T\nHOME=/Users/dev-a\nNODE_OPTIONS=--max-old-space-size=4096\nssh git@github.example.com';
        expect(redactDeep(plain)).toEqual({ value: plain, count: 0 });
        expect(redactDeep('LANGFUSE_SECRET_KEY_PR=lf9Qx2Lm7Rt4Vb8Nc1').value).toBe('[redacted: env_variable]');
        expect(redactDeep(`DEPLOY_REF=${TOKEN}`).value).toBe('DEPLOY_REF=[redacted: github_token]');
    });
});

describe('the token shapes the scanner lacks, with fake but well-formed values', () => {
    const fake = (...parts: string[]) => parts.join('');
    const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(12).slice(0, n);
    const alnum = (n: number) => 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6'.repeat(3).slice(0, n);
    const cases: Array<[string, string]> = [
        ['npm_token', fake('npm', '_', alnum(36))],
        ['google_api_key', fake('AI', 'za', alnum(35))],
        ['aws_temporary_key', fake('AS', 'IA', 'ABCDEFGHIJ234567')],
        ['slack_webhook', fake('https://hooks.', 'slack.com/services/', 'T0000EXAMPLE/B0000EXAMPLE/', alnum(24))],
        ['slack_token', fake('xo', 'xp-', '1234567890-', alnum(20))],
        ['slack_token', fake('xo', 'xa-', '2-', alnum(20))],
        ['slack_token', fake('xo', 'xr-', alnum(20))],
        ['bearer_token', fake('Authorization: Bear', 'er ', alnum(40))],
        ['gitlab_token', fake('gl', 'pat-', alnum(20))],
        ['huggingface_token', fake('h', 'f_', alnum(34))],
        ['shopify_token', fake('shp', 'at_', hex(32))],
        ['digitalocean_token', fake('do', 'p_v1_', hex(64))],
        ['linear_key', fake('lin', '_api_', alnum(40))],
        ['postman_key', fake('PM', 'AK-', hex(24), '-', hex(34))],
        ['supabase_token', fake('sb', 'p_', hex(40))],
        ['stripe_webhook_secret', fake('wh', 'sec_', alnum(32))],
        ['groq_key', fake('gs', 'k_', alnum(52))],
        ['mailgun_key', fake('ke', 'y-', hex(32))],
        ['discord_webhook', fake('https://discord.com/api/web', 'hooks/123456789012345678/', alnum(40))],
    ];
    for (const [kind, value] of cases) {
        it(`redacts ${kind}`, () => {
            const out = redactDeep(`seen: ${value} here`);
            expect(out.count, value.slice(0, 12)).toBe(1);
            expect(out.value).not.toContain(value.slice(-12));
            expect(out.value).toContain(`[redacted: ${kind}]`);
        });
    }
});

describe('every judge\'s answer passes the secret scanner before it is stored or shown', () => {
    let repo: string;
    let judges: FakeJudges;
    beforeEach(() => {
        judges = installFakeJudges();
        repo = makeRepo();
    });
    afterEach(() => {
        judges.remove();
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('a read-only judge too: the value never reaches the result, the verdict or the record, which say how many were redacted; the keys are unchanged', async () => {
        const config = ConfigSchema.parse({ version: 1, review: { coverage: false, reviewer: { enabled: true, reviewers: ['claude'] } } });
        await runReviewer(repo, 'main', config, defaultExec, () => undefined, { blind: true, force: true });
        const clean = (await VerdictStore.open(repo, defaultExec))!.branchState('feature')!;
        const finding = { class: 'correctness', severity: 'should', file: 'src/job.ts', line: 2, issue: `the home config holds ${TOKEN}`, why: 'x', input: '', consequence: '', quote: 'return 1;' };
        judges.behave({ answer: JSON.stringify({ ...EMPTY_VERDICT, findings: [finding] }) });
        const result = await runReviewer(repo, 'main', config, defaultExec, () => undefined, { blind: true, force: true });
        const caveat = "the judge's answer contained 1 secret-like value; redacted";
        expect(result.mode?.caveats).toEqual([caveat]);
        expect(result.record?.caveats).toEqual([caveat]);
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(JSON.stringify(result)).toContain('[redacted: github_token]');
        const state = (await VerdictStore.open(repo, defaultExec))!.branchState('feature')!;
        const stored = path.dirname(state.verdict);
        const files = fs.readdirSync(stored, { recursive: true }).map(name => path.join(stored, String(name))).filter(file => fs.statSync(file).isFile());
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) expect(fs.readFileSync(file, 'utf8'), file).not.toContain(TOKEN);
        expect([state.inputsKey, state.rulesHash]).toEqual([clean.inputsKey, clean.rulesHash]);
    });

    it('a finding on a committed token stays verified and blocking, with both switches off; its quote is redacted, and a stored verdict reused keeps it', async () => {
        fs.writeFileSync(path.join(repo, 'src/config.ts'), `export const token = "${TOKEN}";\n`);
        gitIn(repo, 'add', '-A');
        gitIn(repo, 'commit', '-qm', 'config');
        const config = ConfigSchema.parse({ version: 1, review: { coverage: false, reviewer: { enabled: true, reviewers: ['claude'] } } });
        const finding = { class: 'security', severity: 'blocking', file: 'src/config.ts', line: 1, issue: 'a GitHub token is committed', why: 'it is in the history', input: 'anyone who clones', consequence: 'the token is public', quote: `export const token = "${TOKEN}";` };
        judges.behave({ answer: JSON.stringify({ ...EMPTY_VERDICT, findings: [finding] }) });
        const redactedQuote = 'export const token = "[redacted: github_token]";';
        const first = await runReviewer(repo, 'main', config, defaultExec, () => undefined, { blind: true, force: true });
        expect(first.outcome).toBe('findings');
        expect(first.items.map(item => item.quote)).toEqual([redactedQuote]);
        expect(first.unverified).toEqual([]);
        expect(JSON.stringify(first)).not.toContain(TOKEN);
        // The stored verdict, decided again (its accounting gone): the redacted quote keeps its confirmation.
        const store = (await VerdictStore.open(repo, defaultExec))!;
        fs.rmSync(store.decidedPath(store.branchState('feature')!.verdict));
        const runs = judges.runs().length;
        const again = await runReviewer(repo, 'main', config, defaultExec, () => undefined, { blind: true });
        expect(judges.runs().length).toBe(runs); // no judge ran
        expect(again.items.map(item => item.quote)).toEqual([redactedQuote]);
        expect(again.unverified).toEqual([]);
    });

    it('a stored redacted quote no review confirmed never verifies, even where the checkout has the secret', async () => {
        const { storedVerifier } = await import('./redact.js');
        const verify = storedVerifier(() => true, []);
        expect(verify('src/config.ts', 1, 'export const token = "[redacted: github_token]";')).toBe(false);
        expect(verify('src/job.ts', 2, 'return 1;')).toBe(true);
    });
});
