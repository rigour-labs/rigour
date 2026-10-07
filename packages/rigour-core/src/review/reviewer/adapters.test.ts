import { describe, expect, it } from 'vitest';
import { ADAPTERS } from './adapters.js';

/** A real `codex exec --json` run (codex-cli 0.160.1), the warning's path shortened: the shape the adapter must read. */
const CODEX = [
    '{"type":"thread.started","thread_id":"01a11477-f9fd-7472-8d31-5863de4cbbdb"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\\n  user (~/.codex/config.toml)"}}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\\"answers\\":[{\\"id\\":\\"a1\\",\\"call\\":\\"unsure\\",\\"evidence\\":\\"none\\"}]}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":26565,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":24,"reasoning_output_tokens":0}}',
].join('\n');

describe('reading an agent CLI\'s answer', () => {
    it('takes Codex\'s last agent message, never a warning, and its tokens', () => {
        expect(ADAPTERS.codex.answer(CODEX)).toEqual({ text: '{"answers":[{"id":"a1","call":"unsure","evidence":"none"}]}', tokens: { input: 26565, output: 24 } });
    });

    it('takes Claude Code\'s result, its cost and its tokens', () => {
        const out = JSON.stringify({ result: '{"prior_points":[]}', total_cost_usd: 0.42, usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 300 } });
        expect(ADAPTERS.claude.answer(out)).toEqual({ text: '{"prior_points":[]}', costUsd: 0.42, tokens: { input: 1000, output: 300 } });
    });

    it('falls back to the raw output when it is not what the CLI usually prints', () => {
        expect(ADAPTERS.claude.answer('not json')).toEqual({ text: 'not json' });
        expect(ADAPTERS.codex.answer('plain text')).toEqual({ text: 'plain text' });
    });
});
