import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatReply, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';
import { reviewWithTools } from './agent-review.js';
import { verifyCodeFindings } from './code-verifier.js';

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-'));
    fs.writeFileSync(path.join(repo, 'limits.ts'), 'export const MAX_ROWS = 0;\n');
    fs.writeFileSync(path.join(repo, 'page.ts'), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n'));
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const context: CodeContext = { file: 'page.ts', language: 'typescript', text: '1| export function page() {}', ranges: [[1, 5]], source: 'export function page() {}' };

function scripted(replies: ChatReply[]) {
    const seen: Array<{ messages: ChatMessage[]; tools: number; toolChoice?: string }> = [];
    const provider: InferenceProvider = {
        name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {}, analyze: async () => '',
        chat: async (messages, tools, options) => {
            seen.push({ messages: [...messages], tools: tools.length, toolChoice: options?.toolChoice });
            return replies.shift() ?? { text: '{"findings": []}', toolCalls: [] };
        },
    };
    return { provider, seen };
}

const findingJson = (line: number, description: string) =>
    JSON.stringify({ findings: [{ category: 'correctness', severity: 'high', file: 'page.ts', line, description, suggestion: 's', confidence: 0.9 }] });

describe('reviewWithTools', () => {
    it('runs the tools the model asks for, then grounds its finding in what it read', async () => {
        const { provider, seen } = scripted([
            { text: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'limits.ts' } }, { id: 't2', name: 'read_file', arguments: { path: 'page.ts', start_line: 40, end_line: 45 } }] },
            { text: findingJson(42, '`MAX_ROWS` is 0, so the page loop never runs.'), toolCalls: [] },
        ]);
        const result = await reviewWithTools(provider, context, '', repo, {});
        expect(result.toolCalls).toBe(2);
        const toolResults = seen[1].messages.filter(m => m.role === 'tool').map(m => m.content);
        expect(toolResults[0]).toContain('export const MAX_ROWS = 0;');
        // Line 42 was outside the sent source, but the model read it, and it read MAX_ROWS.
        expect(verifyCodeFindings(result.findings, [result.context])).toHaveLength(1);
        expect(verifyCodeFindings(result.findings, [context])).toHaveLength(0);
    });

    it('forbids tool calls after the budget, keeping the tools defined for the history, and asks for the answer', async () => {
        const greedy = Array.from({ length: 20 }, (_, i) => ({ text: '', toolCalls: [{ id: `t${i}`, name: 'grep', arguments: { pattern: 'line' } }] }));
        const { provider, seen } = scripted(greedy);
        const result = await reviewWithTools(provider, context, '', repo, {});
        expect(result.toolCalls).toBeLessThanOrEqual(12);
        expect(seen.at(-1)).toMatchObject({ tools: 2, toolChoice: 'none' });
        expect(result.findings).toEqual([]);
    });

    it('refuses a provider that cannot call tools', async () => {
        const provider = { name: 'local', isAvailable: async () => true, setup: async () => {}, dispose: () => {}, analyze: async () => '' };
        await expect(reviewWithTools(provider, context, '', repo, {})).rejects.toThrow('cannot call tools');
    });
});
