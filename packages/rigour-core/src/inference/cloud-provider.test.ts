import { beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.fn();
const anthropicCreate = vi.fn();

vi.mock('openai', () => ({
    default: class { chat = { completions: { create: openaiCreate } }; },
}));
vi.mock('@anthropic-ai/sdk', () => ({
    default: class { messages = { create: anthropicCreate }; },
}));

const { CloudProvider } = await import('./cloud-provider.js');
const { priceTokens } = await import('./pricing.js');

beforeEach(() => {
    openaiCreate.mockReset();
    anthropicCreate.mockReset();
});

describe('CloudProvider', () => {
    it('passes the per-call timeout to the SDK request', async () => {
        anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } });
        const provider = new CloudProvider('claude', 'k', { modelName: 'claude-sonnet-5-5' });
        await provider.setup();
        await provider.analyze('p', { timeout: 30_000 });
        expect(anthropicCreate.mock.calls[0][1]).toEqual({ timeout: 30_000 });
    });

    it('prices tokens at list price when the provider reports no cost', async () => {
        anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } });
        const provider = new CloudProvider('claude', 'k', { modelName: 'claude-sonnet-5-5' });
        await provider.setup();
        await provider.analyze('p');
        expect(provider.usage()).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000, costUsd: 3 });
    });

    it('asks OpenRouter for its own cost, and uses it', async () => {
        openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 500, completion_tokens: 50, cost: 0.0123 } });
        const provider = new CloudProvider('openrouter', 'k', { baseUrl: 'https://openrouter.ai/api/v1', modelName: 'anthropic/claude-sonnet-5.5' });
        await provider.setup();
        await provider.analyze('p');
        expect(openaiCreate.mock.calls[0][0].usage).toEqual({ include: true });
        expect(provider.usage()).toEqual({ inputTokens: 500, outputTokens: 50, costUsd: 0.0123 });
    });

    it('sends no OpenRouter-only field to other endpoints, and reports no cost for an unpriced model', async () => {
        openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 500, completion_tokens: 50 } });
        const provider = new CloudProvider('openai', 'k', { modelName: 'some-new-model' });
        await provider.setup();
        await provider.analyze('p');
        expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty('usage');
        expect(provider.usage()).toEqual({ inputTokens: 500, outputTokens: 50 });
    });
});

describe('CloudProvider.chat', () => {
    const history = [
        { role: 'user' as const, content: 'review' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'x.ts' } }, { id: 'b', name: 'grep', arguments: { pattern: 'y' } }] },
        { role: 'tool' as const, toolCallId: 'a', content: 'x' },
        { role: 'tool' as const, toolCallId: 'b', content: 'y' },
    ];
    const tools = [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }];

    it('speaks Anthropic tool use: grouped tool results, tool_use blocks back', async () => {
        anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c', name: 'read_file', input: { path: 'z.ts' } }] });
        const provider = new CloudProvider('claude', 'k', { modelName: 'claude-sonnet-5-5' });
        await provider.setup();
        const reply = await provider.chat(history, tools);
        const sent = anthropicCreate.mock.calls[0][0];
        expect(sent.messages).toHaveLength(3);
        expect(sent.messages[2].content.map((b: any) => b.tool_use_id)).toEqual(['a', 'b']);
        expect(sent.tools[0]).toEqual({ name: 'read_file', description: 'd', input_schema: { type: 'object' } });
        expect(reply).toEqual({ text: 'checking', toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'z.ts' } }] });
    });

    it('speaks OpenAI function calling, and survives malformed arguments', async () => {
        openaiCreate.mockResolvedValue({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', function: { name: 'grep', arguments: '{not json' } }] } }] });
        const provider = new CloudProvider('openai', 'k', { modelName: 'm' });
        await provider.setup();
        const reply = await provider.chat(history, tools);
        const sent = openaiCreate.mock.calls[0][0];
        expect(sent.messages[1].tool_calls[0].function).toEqual({ name: 'read_file', arguments: '{"path":"x.ts"}' });
        expect(sent.messages[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: 'x' });
        expect(sent.tools[0].type).toBe('function');
        expect(reply).toEqual({ text: '', toolCalls: [{ id: 'c', name: 'grep', arguments: {} }] });
    });
});

describe('priceTokens', () => {
    it('prices known models and refuses to guess for the rest', () => {
        expect(priceTokens('anthropic/claude-opus-5.5', 1_000_000, 1_000_000)).toBe(24);
        expect(priceTokens('mystery-7b', 1, 1)).toBeUndefined();
    });
});
