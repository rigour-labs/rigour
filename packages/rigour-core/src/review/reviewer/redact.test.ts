import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { runReviewer } from '../reviewer.js';
import { defaultExec } from './exec.js';
import { EMPTY_VERDICT, installFakeJudges, makeRepo, type FakeJudges } from './__tests__/judge-fakes.js';
import { redactOutput } from './redact.js';
import { VerdictStore } from './store.js';

/** Synthetic credentials in the shapes the scanner knows, built at run time so no literal sits in the source. */
const TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const KEY = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----'].join('\n');

describe("redacting a judge's output", () => {
    it('replaces each secret with its kind, keeps the JSON parsing, a private key to its END line, and nothing else changes', () => {
        const answer = JSON.stringify({ findings: [{ quote: `token = "${TOKEN}"` }, { quote: '[1, 2]' }] });
        const out = redactOutput([JSON.stringify({ type: 'result', result: answer }), 'plain', KEY, 'after'].join('\n'));
        expect(out.count).toBe(2);
        expect(out.text).not.toContain(TOKEN);
        expect(out.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
        const result = JSON.parse(JSON.parse(out.text.split('\n')[0]).result);
        expect(result.findings[0].quote).toBe('token = "[redacted: github_token]"');
        expect(result.findings[1].quote).toBe('[1, 2]'); // a quote that looks like JSON is untouched
        expect(out.text.split('\n').slice(1)).toEqual(['plain', '[redacted: private_key]', 'after']);
        const clean = '{"a": 1}\nno secrets here';
        expect(redactOutput(clean)).toEqual({ text: clean, count: 0 });
    });
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
});
