import { createHash } from 'crypto';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { runReviewer } from '../reviewer.js';
import { defaultExec } from './exec.js';
import { installFakeJudges, makeRepo, portable, write, type FakeJudges } from './__tests__/judge-fakes.js';
import { VerdictStore } from './store.js';

/**
 * A changed verdict key re-runs every cached review, paid, for every user. With review.reviewer.instructions and
 * run_code unset, the keys and the prompt must be exactly what 7.0.14 produced: these values were taken from it.
 */
const PINNED = {
    single: { inputsKey: '43861ab5c61b6153', rulesHash: '58cd707dc0022766', prompt: 'bc384b6a1d4df710' },
    orchestrator: { inputsKey: '0012f534ca232cf4', rulesHash: '58cd707dc0022766', prompt: 'c0f54c7f243ce8b3' },
};

let repo: string;
let judges: FakeJudges;
beforeEach(() => {
    judges = installFakeJudges();
    repo = makeRepo({ 'AGENTS.md': '# Rules\n- Bound every read.\n' });
});
afterEach(() => {
    judges.remove();
    fs.rmSync(repo, { recursive: true, force: true });
});

const config = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, review: { coverage: false, reviewer: { enabled: true, reviewers: ['claude'], ...extra } } });
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function keysOf(extra: Record<string, unknown>, orchestrator: boolean): Promise<{ inputsKey?: string; rulesHash?: string; prompt: string }> {
    const result = await runReviewer(repo, 'main', config(extra), defaultExec, () => undefined, { blind: true, force: true, orchestrator });
    expect(result.outcome).toBe('passed');
    const state = (await VerdictStore.open(repo, defaultExec))!.branchState('feature')!;
    return { inputsKey: state.inputsKey, rulesHash: state.rulesHash, prompt: hash(portable(judges.runs().at(-1)!.prompt, repo)) };
}

describe('the verdict fingerprint with the judge switches unset', () => {
    it('is byte-identical to 7.0.14 for one judge and for the orchestrator', async () => {
        expect(await keysOf({}, false)).toEqual(PINNED.single);
        expect(await keysOf({}, true)).toEqual(PINNED.orchestrator);
    });

    it('changes, keys and prompt, once the team names its review instructions or turns run_code on', async () => {
        write(repo, { 'docs/review-rubric.md': 'Check every migration runs before the code that needs it.\n' });
        const withInstructions = await keysOf({ instructions: 'docs/review-rubric.md' }, false);
        expect(withInstructions.inputsKey).not.toBe(PINNED.single.inputsKey);
        expect(withInstructions.rulesHash).not.toBe(PINNED.single.rulesHash);
        expect(withInstructions.prompt).not.toBe(PINNED.single.prompt);
        const withRunCode = await keysOf({ run_code: 'on' }, false);
        expect(withRunCode.inputsKey).not.toBe(PINNED.single.inputsKey);
        expect(withRunCode.inputsKey).not.toBe(withInstructions.inputsKey);
    });
});
