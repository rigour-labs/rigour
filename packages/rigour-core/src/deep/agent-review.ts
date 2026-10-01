/**
 * Agentic review of one changed file: the model reviews it and may look
 * things up (read files, search the repository) before it answers.
 *
 * Used when a cloud review has no diff to read as a whole (`rigour check
 * <paths> --deep`); a pull request is reviewed as one conversation instead
 * (pr-review.ts). What the model read extends the grounding context, so a
 * finding it supports with code it looked up is still verified against code
 * it actually saw.
 */
import type { DeepFinding, InferenceOptions, InferenceProvider } from '../inference/types.js';
import type { CodeContext } from './code-context.js';
import { buildCodeReviewPrompt } from './code-review-prompt.js';
import { parseFindings } from './parse-findings.js';
import type { ReviewToolbox } from './review-tools.js';
import { runToolLoop } from './tool-loop.js';

const BUDGET = { maxToolCalls: 12, maxTurns: 8 };

const TOOL_GUIDANCE = `TOOLS: you can call read_file and grep. Before you report a defect that depends on code you were not shown `
    + `(a caller, a callee, a type, a constant, a config value), look it up. Drop a suspicion the code disproves. `
    + `You have at most ${BUDGET.maxToolCalls} tool calls; when you are done, answer with the JSON findings only.`;

export interface AgentReviewResult {
    findings: DeepFinding[];
    /** The sent context, extended with what the model read in the reviewed file. */
    context: CodeContext;
    toolCalls: number;
}

export async function reviewWithTools(
    provider: InferenceProvider, context: CodeContext, reference: string, cwd: string, inference: InferenceOptions,
): Promise<AgentReviewResult> {
    const prompt = `${buildCodeReviewPrompt(context, reference)}\n\n${TOOL_GUIDANCE}`;
    const loop = await runToolLoop(provider, prompt, cwd, inference, BUDGET);
    return { findings: parseFindings(loop.text), context: grounded(context, loop.toolbox), toolCalls: loop.toolCalls };
}

/** Lines of the reviewed file the model read count as shown; so does any text it read, for cited identifiers. */
function grounded(context: CodeContext, toolbox: ReviewToolbox): CodeContext {
    const reads = toolbox.reads.get(context.file) ?? [];
    if (reads.length === 0 && !toolbox.readText) return context;
    return { ...context, ranges: [...context.ranges, ...reads], source: `${context.source}\n${toolbox.readText}` };
}
