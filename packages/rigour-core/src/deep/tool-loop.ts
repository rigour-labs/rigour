/**
 * A bounded tool-using conversation: the model reads the repository through
 * ReviewToolbox until it answers, runs out of tool calls, or runs out of
 * turns. After the budget, tools stay defined (a history with tool calls
 * needs them) but calls are forbidden, and the model is asked to answer.
 */
import type { ChatMessage, InferenceOptions, InferenceProvider } from '../inference/types.js';
import { REVIEW_TOOLS, ReviewToolbox } from './review-tools.js';

export interface ToolLoopBudget {
    maxToolCalls: number;
    maxTurns: number;
}

export interface ToolLoopResult {
    /** The model's final answer. */
    text: string;
    toolbox: ReviewToolbox;
    toolCalls: number;
}

export async function runToolLoop(
    provider: InferenceProvider, prompt: string, cwd: string, inference: InferenceOptions, budget: ToolLoopBudget,
): Promise<ToolLoopResult> {
    if (!provider.chat) throw new Error(`${provider.name} cannot call tools`);
    const toolbox = new ReviewToolbox(cwd);
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    let toolCalls = 0;
    for (let turn = 0; turn < budget.maxTurns; turn++) {
        const exhausted = toolCalls >= budget.maxToolCalls;
        const reply = await provider.chat(messages, REVIEW_TOOLS, { ...inference, jsonMode: false, toolChoice: exhausted ? 'none' : 'auto' });
        if (reply.toolCalls.length === 0 || exhausted) return { text: reply.text, toolbox, toolCalls };
        messages.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
            toolCalls++;
            const result = toolCalls <= budget.maxToolCalls ? toolbox.run(call) : 'Tool budget used up; answer now.';
            messages.push({ role: 'tool', toolCallId: call.id, content: result });
        }
    }
    messages.push({ role: 'user', content: 'Answer now with the JSON findings only.' });
    const final = await provider.chat(messages, REVIEW_TOOLS, { ...inference, jsonMode: false, toolChoice: 'none' });
    return { text: final.text, toolbox, toolCalls };
}
