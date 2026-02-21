/**
 * Deep Analysis Gate — LLM-powered code quality analysis.
 *
 * Three-step pipeline:
 * 1. AST extracts facts → "UserService has 8 public methods touching 4 domains"
 * 2. LLM interprets facts → "UserService violates Single Responsibility"
 * 3. AST verifies LLM → Does UserService actually have those methods? ✓
 *
 * AST grounds LLM. LLM interprets AST. Neither works alone.
 */
import { Gate, GateContext } from './base.js';
import { Failure, Provenance, DeepOptions } from '../types/index.js';
import { createProvider, type InferenceProvider, type DeepFinding } from '../inference/index.js';
import { extractFacts, factsToPromptString, chunkFacts, buildAnalysisPrompt, buildCrossFilePrompt, verifyFindings } from '../deep/index.js';
import { Logger } from '../utils/logger.js';

/** Max files to analyze before truncating (prevents OOM on huge repos) */
const MAX_ANALYZABLE_FILES = 500;

/** Setup timeout: 120s for model download, 30s for API connection */
const SETUP_TIMEOUT_MS = 120_000;

export interface DeepGateConfig {
    options: DeepOptions;
    checks?: Record<string, boolean>;
    threads?: number;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    onProgress?: (message: string) => void;
}

export class DeepAnalysisGate extends Gate {
    private config: DeepGateConfig;
    private provider: InferenceProvider | null = null;

    constructor(config: DeepGateConfig) {
        super('deep-analysis', 'Deep Code Quality Analysis');
        this.config = config;
    }

    protected get provenance(): Provenance {
        return 'deep-analysis';
    }

    async run(context: GateContext): Promise<Failure[]> {
        const { onProgress } = this.config;
        const failures: Failure[] = [];
        const startTime = Date.now();

        try {
            // Step 0: Initialize inference provider (with timeout)
            onProgress?.('\n  Setting up Rigour Brain...\n');
            this.provider = createProvider(this.config.options);

            await Promise.race([
                this.provider.setup(onProgress),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Setup timed out. Check network or model availability.')), SETUP_TIMEOUT_MS)
                ),
            ]);

            const isLocal = !this.config.options.apiKey || this.config.options.provider === 'local';
            if (isLocal) {
                onProgress?.('\n  🔒 100% local analysis. Your code never leaves this machine.\n');
            } else {
                onProgress?.(`\n  ☁️  Using ${this.config.options.provider} API. Code is sent to cloud.\n`);
            }

            // Step 1: AST extracts facts
            onProgress?.('  Extracting code facts...');
            let allFacts = await extractFacts(context.cwd, context.ignore);

            if (allFacts.length === 0) {
                onProgress?.('  No analyzable files found. Check ignore patterns and file extensions.');
                return [];
            }

            // Cap file count to prevent OOM on huge repos
            if (allFacts.length > MAX_ANALYZABLE_FILES) {
                onProgress?.(`  ⚠ Found ${allFacts.length} files, capping at ${MAX_ANALYZABLE_FILES} (largest files prioritized).`);
                // Sort by line count descending — analyze the biggest files first
                allFacts.sort((a, b) => b.lineCount - a.lineCount);
                allFacts = allFacts.slice(0, MAX_ANALYZABLE_FILES);
            }

            const agentCount = this.config.options.agents || 1;
            const isCloud = !!this.config.options.apiKey;

            onProgress?.(`  Found ${allFacts.length} files to analyze${agentCount > 1 ? ` with ${agentCount} parallel agents` : ''}.`);

            // Step 2: LLM interprets facts (in chunks)
            const chunks = chunkFacts(allFacts);
            const allFindings: DeepFinding[] = [];
            let failedChunks = 0;

            if (agentCount > 1 && isCloud) {
                // ── Multi-agent mode: partition chunks across N agents, analyze in parallel ──
                // Each agent gets its own provider instance for true parallelism.
                // Local mode stays sequential (single sidecar process).
                onProgress?.(`  Spawning ${agentCount} parallel agents...`);

                const agentBuckets: (typeof chunks)[] = Array.from({ length: agentCount }, () => []);
                chunks.forEach((chunk, i) => agentBuckets[i % agentCount].push(chunk));

                // Create N independent provider instances
                const agentProviders: InferenceProvider[] = [];
                for (let a = 0; a < agentCount; a++) {
                    if (agentBuckets[a].length === 0) continue;
                    const p = createProvider(this.config.options);
                    await p.setup(); // Already connected — cloud setup is instant after first
                    agentProviders.push(p);
                }

                // Run all agents in parallel
                const agentResults = await Promise.allSettled(
                    agentProviders.map(async (provider, agentIdx) => {
                        const bucket = agentBuckets[agentIdx];
                        const findings: DeepFinding[] = [];
                        let failed = 0;

                        for (let ci = 0; ci < bucket.length; ci++) {
                            const globalIdx = agentIdx + ci * agentCount + 1;
                            onProgress?.(`  Agent ${agentIdx + 1}: batch ${ci + 1}/${bucket.length} (global ${globalIdx}/${chunks.length})`);

                            const factsStr = factsToPromptString(bucket[ci]);
                            const prompt = buildAnalysisPrompt(factsStr, this.config.checks);

                            try {
                                const response = await provider.analyze(prompt, {
                                    maxTokens: this.config.maxTokens || 8192,
                                    temperature: this.config.temperature || 0.1,
                                    timeout: this.config.timeoutMs || 120000,
                                    jsonMode: true,
                                });
                                findings.push(...parseFindings(response));
                            } catch (error: any) {
                                failed++;
                                Logger.warn(`Agent ${agentIdx + 1} chunk ${ci + 1} failed: ${error.message}`);
                            }
                        }

                        return { findings, failed };
                    })
                );

                // Merge results and dispose extra providers
                for (let i = 0; i < agentResults.length; i++) {
                    const result = agentResults[i];
                    if (result.status === 'fulfilled') {
                        allFindings.push(...result.value.findings);
                        failedChunks += result.value.failed;
                    } else {
                        failedChunks += agentBuckets[i].length;
                        Logger.warn(`Agent ${i + 1} failed entirely: ${result.reason?.message || 'unknown'}`);
                    }
                    agentProviders[i]?.dispose();
                }

                onProgress?.(`  All ${agentCount} agents completed.`);

            } else {
                // ── Single-agent mode: sequential chunk processing ──
                let chunkIndex = 0;
                for (const chunk of chunks) {
                    chunkIndex++;
                    onProgress?.(`  Analyzing batch ${chunkIndex}/${chunks.length}...`);

                    const factsStr = factsToPromptString(chunk);
                    const prompt = buildAnalysisPrompt(factsStr, this.config.checks);

                    try {
                        const response = await this.provider.analyze(prompt, {
                            maxTokens: this.config.maxTokens || (isCloud ? 4096 : 512),
                            temperature: this.config.temperature || 0.1,
                            timeout: this.config.timeoutMs || (isCloud ? 120000 : 60000),
                            jsonMode: true,
                        });

                        const findings = parseFindings(response);
                        allFindings.push(...findings);
                    } catch (error: any) {
                        failedChunks++;
                        Logger.warn(`Chunk ${chunkIndex} inference failed: ${error.message}`);
                        onProgress?.(`  ⚠ Batch ${chunkIndex} failed: ${error.message}`);
                    }
                }
            }

            // Cross-file analysis (if we have enough files and at least some chunks succeeded)
            if (allFacts.length >= 3 && failedChunks < chunks.length) {
                onProgress?.('  Running cross-file analysis...');
                try {
                    const crossPrompt = buildCrossFilePrompt(allFacts);
                    const crossResponse = await this.provider.analyze(crossPrompt, {
                        maxTokens: this.config.maxTokens || (isCloud ? 4096 : 512),
                        temperature: this.config.temperature || 0.1,
                        timeout: this.config.timeoutMs || (isCloud ? 120000 : 60000),
                        jsonMode: true,
                    });
                    const crossFindings = parseFindings(crossResponse);
                    allFindings.push(...crossFindings);
                } catch (error: any) {
                    Logger.warn(`Cross-file analysis failed: ${error.message}`);
                }
            }

            // Step 3: AST verifies LLM
            onProgress?.('  Verifying findings...');
            const verified = verifyFindings(allFindings, allFacts);
            const durationMs = Date.now() - startTime;

            onProgress?.(`  ✓ ${verified.length} verified findings (${allFindings.length - verified.length} dropped) in ${(durationMs / 1000).toFixed(1)}s`);

            if (failedChunks > 0) {
                onProgress?.(`  ⚠ ${failedChunks}/${chunks.length} batches failed — results may be incomplete.`);
            }

            // Convert to Failure format
            for (const finding of verified) {
                const failure = this.createFailure(
                    finding.description,
                    [finding.file],
                    finding.suggestion,
                    `[${finding.category}] ${finding.description.substring(0, 80)}`,
                    finding.line,
                    undefined,
                    finding.severity
                );

                // Tag with deep analysis metadata
                (failure as any).confidence = finding.confidence;
                (failure as any).source = 'llm';
                (failure as any).category = finding.category;
                (failure as any).verified = finding.verified;
                failures.push(failure);
            }

        } catch (error: any) {
            Logger.error(`Deep analysis failed: ${error.message}`);
            onProgress?.(`  ⚠ Deep analysis error: ${error.message}`);
            // Don't fail the whole check — deep is advisory
        } finally {
            this.provider?.dispose();
        }

        return failures;
    }
}

/**
 * Parse LLM response into structured findings.
 * Handles various response formats (raw JSON, markdown-wrapped JSON, etc.)
 */
function parseFindings(response: string): DeepFinding[] {
    if (!response || response.trim().length === 0) {
        Logger.warn('Empty LLM response received');
        return [];
    }

    try {
        // Try direct JSON parse first
        const parsed = JSON.parse(response);
        if (Array.isArray(parsed.findings)) return validateFindings(parsed.findings);
        if (Array.isArray(parsed)) return validateFindings(parsed);
        return [];
    } catch {
        // Try extracting JSON from markdown code blocks
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (Array.isArray(parsed.findings)) return validateFindings(parsed.findings);
                if (Array.isArray(parsed)) return validateFindings(parsed);
            } catch {
                // Fall through
            }
        }

        // Try finding JSON object in response
        const objectMatch = response.match(/\{[\s\S]*"findings"[\s\S]*\}/);
        if (objectMatch) {
            try {
                const parsed = JSON.parse(objectMatch[0]);
                if (Array.isArray(parsed.findings)) return validateFindings(parsed.findings);
            } catch {
                // Give up
            }
        }

        // Last resort: try to recover truncated JSON arrays
        // LLMs sometimes exceed token limits, truncating the response mid-JSON
        const recovered = recoverTruncatedFindings(response);
        if (recovered.length > 0) {
            Logger.info(`Recovered ${recovered.length} findings from truncated response`);
            return recovered;
        }

        Logger.warn(`Could not parse LLM response as findings JSON. First 200 chars: ${response.substring(0, 200)}`);
        return [];
    }
}

/**
 * Attempt to recover individual finding objects from a truncated JSON response.
 * Extracts complete JSON objects from partial arrays.
 */
function recoverTruncatedFindings(response: string): DeepFinding[] {
    const findings: DeepFinding[] = [];
    // Match individual complete objects within the response
    const objectRegex = /\{\s*"category"\s*:\s*"[^"]+"\s*,[\s\S]*?"description"\s*:\s*"[^"]*"[^}]*\}/g;
    let match;
    while ((match = objectRegex.exec(response)) !== null) {
        try {
            const obj = JSON.parse(match[0]);
            if (obj.category && obj.file && obj.description) {
                findings.push(obj);
            }
        } catch {
            // Individual object was itself truncated — skip
        }
    }
    return validateFindings(findings);
}

/**
 * Validate and sanitize findings from LLM response.
 * Drops malformed entries that lack required fields.
 */
function validateFindings(raw: any[]): DeepFinding[] {
    return raw.filter(f => {
        if (!f || typeof f !== 'object') return false;
        if (!f.category || typeof f.category !== 'string') return false;
        if (!f.file || typeof f.file !== 'string') return false;
        if (!f.description || typeof f.description !== 'string') return false;
        // Normalize confidence
        if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
            f.confidence = 0.5;
        }
        // Normalize severity
        const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];
        if (!validSeverities.includes(f.severity)) {
            f.severity = 'medium';
        }
        return true;
    });
}
