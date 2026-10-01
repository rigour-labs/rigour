/**
 * Agentic review: the model reviews a changed file and may look things up
 * (read files, search the repository) before it answers.
 *
 * On nine real PRs, the same model family pre-empted 1 of 9 human-acted
 * review comments from fixed chunks and 4 of 10 when it could read the
 * repository: most real defects need a caller, a callee or a type the chunk
 * did not include. The loop is bounded by tool calls and turns, and what the
 * model read extends the grounding context, so a finding it supports with
 * code it looked up is still verified against code it actually saw.
 */
import type { ChatMessage, DeepFinding, InferenceOptions, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';
import { buildCodeReviewPrompt } from './code-review-prompt.js';
import { parseFindings } from './parse-findings.js';
import { REVIEW_TOOLS, ReviewToolbox } from './review-tools.js';

const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 8;

const TOOL_GUIDANCE = `TOOLS: you can call read_file and grep. Before you report a defect that depends on code you were not shown `
    + `(a caller, a callee, a type, a constant, a config value), look it up. Drop a suspicion the code disproves. `
    + `You have at most ${MAX_TOOL_CALLS} tool calls; when you are done, answer with the JSON findings only.`;

export interface AgentReviewResult {
    findings: DeepFinding[];
    /** The sent context, extended with what the model read in the reviewed file. */
    context: CodeContext;
    toolCalls: number;
}

export async function reviewWithTools(
    provider: InferenceProvider, context: CodeContext, reference: string, cwd: string, inference: InferenceOptions,
): Promise<AgentReviewResult> {
    if (!provider.chat) throw new Error(`${provider.name} cannot call tools`);
    const toolbox = new ReviewToolbox(cwd);
    const messages: ChatMessage[] = [{ role: 'user', content: `${buildCodeReviewPrompt(context, reference)}\n\n${TOOL_GUIDANCE}` }];
    let toolCalls = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const tools = toolCalls < MAX_TOOL_CALLS ? REVIEW_TOOLS : [];
        const reply = await provider.chat(messages, tools, { ...inference, jsonMode: false });
        if (reply.toolCalls.length === 0 || tools.length === 0) {
            return { findings: parseFindings(reply.text), context: grounded(context, toolbox), toolCalls };
        }
        messages.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
            toolCalls++;
            const result = toolCalls <= MAX_TOOL_CALLS ? toolbox.run(call) : 'Tool budget used up; answer now.';
            messages.push({ role: 'tool', toolCallId: call.id, content: result });
        }
    }
    messages.push({ role: 'user', content: 'Answer now with the JSON findings only.' });
    const final = await provider.chat(messages, [], { ...inference, jsonMode: false });
    return { findings: parseFindings(final.text), context: grounded(context, toolbox), toolCalls };
}

/** Lines of the reviewed file the model read count as shown; so does any text it read, for cited identifiers. */
function grounded(context: CodeContext, toolbox: ReviewToolbox): CodeContext {
    const reads = toolbox.reads.get(context.file) ?? [];
    if (reads.length === 0 && !toolbox.readText) return context;
    return { ...context, ranges: [...context.ranges, ...reads], source: `${context.source}\n${toolbox.readText}` };
}
