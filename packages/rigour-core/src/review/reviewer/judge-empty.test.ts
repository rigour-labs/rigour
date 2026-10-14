import { describe, expect, it } from 'vitest';
import { ADAPTERS } from './adapters.js';
import { emptyAnswer } from './judge-empty.js';

/** Claude Code's success-shaped answer with an expired login reached through another session (--output-format json). */
const EMPTY_CLAUDE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'stop_sequence', duration_api_ms: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
const EMPTY_CODEX = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } });

describe('a judge that answered nothing', () => {
    it('is named with the CLI and how to check its login, for claude and codex', () => {
        expect(emptyAnswer('claude', ADAPTERS.claude.answer(EMPTY_CLAUDE), {})).toBe('the claude CLI answered nothing (0 output tokens); check its login: `claude auth status`');
        expect(emptyAnswer('codex', ADAPTERS.codex.answer(EMPTY_CODEX), {})).toBe('the codex CLI answered nothing (0 output tokens); check its login: `codex login status`');
    });

    it('says it was started inside another agent session when it was', () => {
        expect(emptyAnswer('claude', ADAPTERS.claude.answer(EMPTY_CLAUDE), { CLAUDECODE: '1' })).toContain('; started inside another agent session');
    });

    it('leaves an answer with output, one that reports no usage, and a CLI that reports no tokens alone', () => {
        const answered = JSON.stringify({ type: 'result', result: '{"prior_points": []}', usage: { input_tokens: 10, output_tokens: 5 } });
        expect(emptyAnswer('claude', ADAPTERS.claude.answer(answered), {})).toBeUndefined();
        expect(emptyAnswer('claude', ADAPTERS.claude.answer(JSON.stringify({ result: 'text', total_cost_usd: 1 })), {})).toBeUndefined();
        expect(emptyAnswer('cursor', { tokens: { input: 0, output: 0 } }, {})).toBeUndefined();
    });
});
