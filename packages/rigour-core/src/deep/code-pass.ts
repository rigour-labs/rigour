/**
 * Code pass: per-file review of scoped files with their numbered source.
 * Used for `rigour check <paths> --deep` and `rigour review --deep`.
 */
import path from 'path';
import fs from 'fs-extra';
import type { InferenceProvider } from '../inference/types.js';
import type { FileFacts } from './fact-extractor.js';
import { buildCodeContext, type CodeContext } from './code-context.js';
import { buildCodeReviewPrompt } from './code-review-prompt.js';
import { parseFindings } from './parse-findings.js';
import { buildReferencePack, type ReferencePack } from './reference-pack.js';
import { selfCheck } from './self-check.js';
import { reviewWithTools } from './agent-review.js';
import type { DeepFinding } from '../inference/types.js';
import type { RemovedBlock } from '../utils/diff.js';
import type { PassConfig, PassResult } from './facts-pass.js';
import { Logger } from '../utils/logger.js';

export interface CodePassConfig extends PassConfig {
    cwd: string;
    /** Character budget for one file's source in the prompt. */
    maxSourceChars: number;
    /** Changed lines per file (cwd-relative path → line numbers). */
    focusLines?: Record<string, number[]>;
    /**
     * Stronger tiers only: send reference material with each file, review it
     * twice with that material in opposite orders, and self-check the union.
     */
    reference?: {
        maxChars: number;
        removed?: Record<string, RemovedBlock[]>;
        prBody?: string;
    };
    /** Epoch ms after which no new file is started (the run budget). */
    deadline?: number;
    /** Files reviewed at once. */
    concurrency?: number;
    /** Let a tool-capable provider read the repository while it reviews (agent-review.ts). */
    agentic?: boolean;
}

export interface CodePassResult extends PassResult {
    contexts: CodeContext[];
    /** Findings the model proposed, before the self-check (the max and cloud tiers). */
    proposed: number;
    /** Of those, withdrawn by the self-check. */
    withdrawn: number;
    /** Files not started before the deadline. */
    skipped: number;
    /** Repository lookups the model made (agentic review). */
    toolCalls: number;
}

interface FileReview {
    context?: CodeContext;
    findings: DeepFinding[];
    proposed: number;
    withdrawn: number;
    toolCalls?: number;
    error?: string;
}

export async function runCodePass(provider: InferenceProvider, facts: FileFacts[], config: CodePassConfig): Promise<CodePassResult> {
    const result: CodePassResult = { findings: [], chunksTotal: facts.length, chunksFailed: 0, contexts: [], proposed: 0, withdrawn: 0, skipped: 0, toolCalls: 0 };
    const reviews: Array<FileReview | undefined> = new Array(facts.length);
    let next = 0;
    const worker = async () => {
        while (next < facts.length) {
            const index = next++;
            if (config.deadline !== undefined && Date.now() >= config.deadline) continue;
            config.onProgress?.(`  Reviewing ${facts[index].path} (${index + 1}/${facts.length})...`);
            reviews[index] = await reviewFile(provider, facts[index], config);
        }
    };
    const workers = Math.max(1, Math.min(config.concurrency ?? 1, facts.length));
    await Promise.all(Array.from({ length: workers }, worker));

    // Merge in file order, so the result does not depend on which call finished first.
    for (const review of reviews) {
        if (!review) {
            result.skipped++;
            continue;
        }
        if (review.context) result.contexts.push(review.context);
        if (review.error) recordFailure(result, review.error, config);
        result.findings.push(...review.findings);
        result.proposed += review.proposed;
        result.withdrawn += review.withdrawn;
        result.toolCalls += review.toolCalls ?? 0;
    }
    return result;
}

async function reviewFile(provider: InferenceProvider, file: FileFacts, config: CodePassConfig): Promise<FileReview> {
    const empty: FileReview = { findings: [], proposed: 0, withdrawn: 0 };
    let context: CodeContext;
    try {
        const content = await fs.readFile(path.join(config.cwd, file.path), 'utf-8');
        context = buildCodeContext(file, content, {
            maxChars: config.maxSourceChars,
            focusLines: config.focusLines?.[file.path],
        });
    } catch (error: any) {
        return { ...empty, error: `${file.path}: ${error.message}` };
    }
    const pack = config.reference ? packFor(file.path, config) : undefined;
    if (pack) context = { ...context, source: `${context.source}\n${pack.source}` };
    try {
        if (pack && config.agentic && provider.chat) return await reviewAgentically(provider, context, pack, config);
        if (pack) {
            const checked = await reviewTwiceAndCheck(provider, context, pack, config);
            return { context, findings: checked.kept, proposed: checked.proposed, withdrawn: checked.withdrawn };
        }
        const found = await reviewOnce(provider, context, '', config);
        return { context, findings: found, proposed: found.length, withdrawn: 0 };
    } catch (error: any) {
        return { ...empty, context, error: `${file.path}: ${error.message}` };
    }
}

async function reviewAgentically(provider: InferenceProvider, context: CodeContext, pack: ReferencePack, config: CodePassConfig): Promise<FileReview> {
    const review = await reviewWithTools(provider, context, pack.text, config.cwd, config.inference);
    const found = dedupe(review.findings);
    if (found.length === 0) return { context: review.context, findings: [], proposed: 0, withdrawn: 0, toolCalls: review.toolCalls };
    const checked = await selfCheck(provider, review.context, pack.text, found, config.inference);
    return { context: review.context, findings: checked.kept, proposed: found.length, withdrawn: checked.withdrawn, toolCalls: review.toolCalls };
}

async function reviewOnce(provider: InferenceProvider, context: CodeContext, reference: string, config: CodePassConfig): Promise<DeepFinding[]> {
    return parseFindings(await provider.analyze(buildCodeReviewPrompt(context, reference), config.inference));
}

async function reviewTwiceAndCheck(
    provider: InferenceProvider, context: CodeContext, pack: ReferencePack, config: CodePassConfig,
): Promise<{ kept: DeepFinding[]; proposed: number; withdrawn: number }> {
    const first = await reviewOnce(provider, context, pack.text, config);
    const second = pack.sections.length > 1 ? await reviewOnce(provider, context, [...pack.sections].reverse().join('\n\n'), config) : [];
    const union = dedupe([...first, ...second]);
    if (union.length === 0) return { kept: union, proposed: 0, withdrawn: 0 };
    const checked = await selfCheck(provider, context, pack.text, union, config.inference);
    if (checked.withdrawn > 0) config.onProgress?.(`  Self-check withdrew ${checked.withdrawn} of ${union.length} finding(s) in ${context.file}.`);
    return { kept: checked.kept, proposed: union.length, withdrawn: checked.withdrawn };
}

function packFor(file: string, config: CodePassConfig): ReferencePack {
    const reference = config.reference!;
    return buildReferencePack({
        cwd: config.cwd, file, focusLines: config.focusLines?.[file],
        removed: reference.removed?.[file], prBody: reference.prBody, maxChars: reference.maxChars,
    });
}

function dedupe(findings: DeepFinding[]): DeepFinding[] {
    const seen = new Set<string>();
    return findings.filter(f => {
        const key = `${f.file}:${f.line}:${f.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function recordFailure(result: PassResult, message: string, config: PassConfig): void {
    result.chunksFailed++;
    result.firstError ??= message;
    Logger.warn(`Code review failed for ${message}`);
    config.onProgress?.(`  ⚠ ${message}`);
}
