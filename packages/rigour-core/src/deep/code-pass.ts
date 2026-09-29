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
import type { PassConfig, PassResult } from './facts-pass.js';
import { Logger } from '../utils/logger.js';

export interface CodePassConfig extends PassConfig {
    cwd: string;
    /** Character budget for one file's source in the prompt. */
    maxSourceChars: number;
    /** Changed lines per file (cwd-relative path → line numbers). */
    focusLines?: Record<string, number[]>;
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
        result.contexts.push(context);
        try {
            const response = await provider.analyze(buildCodeReviewPrompt(context), config.inference);
            result.findings.push(...parseFindings(response));
        } catch (error: any) {
            recordFailure(result, `${file.path}: ${error.message}`, config);
        }
    }
    return result;
}

function recordFailure(result: PassResult, message: string, config: PassConfig): void {
    result.chunksFailed++;
    result.firstError ??= message;
    Logger.warn(`Code review failed for ${message}`);
    config.onProgress?.(`  ⚠ ${message}`);
}
