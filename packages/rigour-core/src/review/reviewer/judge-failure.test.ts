import { describe, expect, it } from 'vitest';
import { INVALID_KEY_HINT, judgeFailureHint, withFailureHint } from './judge-failure.js';

/** Claude Code's stream-json answer when its API key is refused (exit 1), as the CLI writes it. */
const REFUSED = { stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Fix external API key', total_cost_usd: 0 })}\n`, stderr: '' };
const KEY = { ANTHROPIC_API_KEY: 'sk-ant-synthetic-stale' };

describe('a judge refused for its API key', () => {
    it("names the ANTHROPIC_API_KEY that reached the claude judge, in its output or its stderr", () => {
        expect(judgeFailureHint('claude', REFUSED, ['RIGOUR_API_KEY'], KEY)).toBe(INVALID_KEY_HINT);
        expect(judgeFailureHint('claude', { stdout: '', stderr: 'Invalid API key · Fix external API key' }, [], KEY)).toBe(INVALID_KEY_HINT);
        expect(INVALID_KEY_HINT).toContain('judge_env: { claude: { unset: [ANTHROPIC_API_KEY] } }');
    });

    it("reads the CLI's final answer, never the files the judge read on the way", () => {
        const quoted = [
            JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Invalid API key · Fix external API key' }] } }),
            JSON.stringify({ type: 'result', is_error: false, result: 'Here is my verdict, not JSON.' }),
        ].join('\n');
        expect(judgeFailureHint('claude', { stdout: quoted, stderr: '' }, [], KEY)).toBeUndefined();
    });

    it('says nothing when no key reached the judge, for another judge, or for another failure', () => {
        expect(judgeFailureHint('claude', REFUSED, [], {})).toBeUndefined();
        expect(judgeFailureHint('claude', REFUSED, ['RIGOUR_API_KEY', 'ANTHROPIC_API_KEY'], KEY)).toBeUndefined();
        expect(judgeFailureHint('codex', REFUSED, [], KEY)).toBeUndefined();
        expect(judgeFailureHint('claude', { stdout: 'not json', stderr: 'timed out' }, [], KEY)).toBeUndefined();
    });

    it('adds the hint to a failed answer only', () => {
        expect(withFailureHint({ error: 'claude: no valid verdict' }, 'the hint')).toEqual({ error: 'claude: no valid verdict (the hint)' });
        expect(withFailureHint({ verdict: 1 }, 'the hint')).toEqual({ verdict: 1 });
        expect(withFailureHint({ error: 'x' }, undefined)).toEqual({ error: 'x' });
    });
});
