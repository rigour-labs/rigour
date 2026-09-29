/**
 * Facts pass: repo-wide analysis from AST facts (no source sent).
 * Used for unscoped `rigour check --deep`.
 */
import type { InferenceOptions, InferenceProvider, DeepFinding } from '../inference/types.js';
import type { FileFacts } from './fact-extractor.js';
import { factsToPromptString } from './fact-extractor.js';
import { buildAnalysisPrompt, buildCrossFilePrompt, chunkFacts } from './prompts.js';
import { parseFindings } from './parse-findings.js';
import { Logger } from '../utils/logger.js';

export interface PassResult {
    findings: DeepFinding[];
    chunksTotal: number;
    chunksFailed: number;
    /** Message of the first failed chunk, for reporting. */
    firstError?: string;
}

export interface PassConfig {
    inference: InferenceOptions;
    checks?: Record<string, boolean>;
    onProgress?: (message: string) => void;
    /** Cloud only: fan chunks out over N providers. */
    agents?: { count: number; create: () => Promise<InferenceProvider> };
}

export async function runFactsPass(provider: InferenceProvider, facts: FileFacts[], config: PassConfig): Promise<PassResult> {
    const chunks = chunkFacts(facts);
    const result = config.agents && config.agents.count > 1
        ? await analyzeWithAgents(chunks, config)
        : await analyzeSequentially(provider, chunks, config);

    if (facts.length >= 3 && result.chunksFailed < result.chunksTotal) {
        config.onProgress?.('  Running cross-file analysis...');
        try {
            const response = await provider.analyze(buildCrossFilePrompt(facts), config.inference);
            result.findings.push(...parseFindings(response));
        } catch (error: any) {
            Logger.warn(`Cross-file analysis failed: ${error.message}`);
        }
    }
    return result;
}

async function analyzeSequentially(provider: InferenceProvider, chunks: FileFacts[][], config: PassConfig): Promise<PassResult> {
    const result: PassResult = { findings: [], chunksTotal: chunks.length, chunksFailed: 0 };
    for (let i = 0; i < chunks.length; i++) {
        config.onProgress?.(`  Analyzing batch ${i + 1}/${chunks.length}...`);
        await analyzeChunk(provider, chunks[i], config, result, `Batch ${i + 1}`);
    }
    return result;
}

async function analyzeWithAgents(chunks: FileFacts[][], config: PassConfig): Promise<PassResult> {
    const { count, create } = config.agents!;
    config.onProgress?.(`  Spawning ${count} parallel agents...`);
    const buckets: FileFacts[][][] = Array.from({ length: count }, () => []);
    chunks.forEach((chunk, i) => buckets[i % count].push(chunk));

    const result: PassResult = { findings: [], chunksTotal: chunks.length, chunksFailed: 0 };
    await Promise.all(buckets.filter(b => b.length > 0).map(async (bucket, agent) => {
        let provider: InferenceProvider;
        try {
            provider = await create();
        } catch (error: any) {
            result.chunksFailed += bucket.length;
            result.firstError ??= error.message;
            return;
        }
        try {
            for (let i = 0; i < bucket.length; i++) {
                await analyzeChunk(provider, bucket[i], config, result, `Agent ${agent + 1} batch ${i + 1}`);
            }
        } finally {
            provider.dispose();
        }
    }));
    config.onProgress?.(`  All ${count} agents completed.`);
    return result;
}

async function analyzeChunk(provider: InferenceProvider, chunk: FileFacts[], config: PassConfig, result: PassResult, label: string): Promise<void> {
    const prompt = buildAnalysisPrompt(factsToPromptString(chunk, Number.POSITIVE_INFINITY), config.checks);
    try {
        result.findings.push(...parseFindings(await provider.analyze(prompt, config.inference)));
    } catch (error: any) {
        result.chunksFailed++;
        result.firstError ??= error.message;
        Logger.warn(`${label} inference failed: ${error.message}`);
        config.onProgress?.(`  ⚠ ${label} failed: ${error.message}`);
    }
}
