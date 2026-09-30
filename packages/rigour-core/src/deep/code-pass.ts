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
}

export interface CodePassResult extends PassResult {
    contexts: CodeContext[];
}

export async function runCodePass(provider: InferenceProvider, facts: FileFacts[], config: CodePassConfig): Promise<CodePassResult> {
    const result: CodePassResult = { findings: [], chunksTotal: facts.length, chunksFailed: 0, contexts: [] };

    for (let i = 0; i < facts.length; i++) {
        const file = facts[i];
        config.onProgress?.(`  Reviewing ${file.path} (${i + 1}/${facts.length})...`);
        let context: CodeContext;
        try {
            const content = await fs.readFile(path.join(config.cwd, file.path), 'utf-8');
            context = buildCodeContext(file, content, {
                maxChars: config.maxSourceChars,
                focusLines: config.focusLines?.[file.path],
            });
        } catch (error: any) {
            recordFailure(result, `${file.path}: ${error.message}`, config);
            continue;
        }
        const pack = config.reference ? packFor(file.path, config) : undefined;
        if (pack) context = { ...context, source: `${context.source}\n${pack.source}` };
        result.contexts.push(context);
        try {
            result.findings.push(...(pack ? await reviewTwiceAndCheck(provider, context, pack, config) : await reviewOnce(provider, context, '', config)));
        } catch (error: any) {
            recordFailure(result, `${file.path}: ${error.message}`, config);
        }
    }
    return result;
}

async function reviewOnce(provider: InferenceProvider, context: CodeContext, reference: string, config: CodePassConfig): Promise<DeepFinding[]> {
    return parseFindings(await provider.analyze(buildCodeReviewPrompt(context, reference), config.inference));
}

async function reviewTwiceAndCheck(provider: InferenceProvider, context: CodeContext, pack: ReferencePack, config: CodePassConfig): Promise<DeepFinding[]> {
    const first = await reviewOnce(provider, context, pack.text, config);
    const second = pack.sections.length > 1 ? await reviewOnce(provider, context, [...pack.sections].reverse().join('\n\n'), config) : [];
    const union = dedupe([...first, ...second]);
    if (union.length === 0) return union;
    const checked = await selfCheck(provider, context, pack.text, union, config.inference);
    if (checked.withdrawn > 0) config.onProgress?.(`  Self-check withdrew ${checked.withdrawn} of ${union.length} finding(s) in ${context.file}.`);
    return checked.kept;
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
