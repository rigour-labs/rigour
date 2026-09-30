/**
 * Deep analysis as the gate runner reports it: summary status, report stats
 * and failures, derived from the deep gate's outcome.
 */
import { DeepAnalysisGate } from './deep-analysis.js';
import type { GateContext } from './base.js';
import type { Config, DeepOptions, Failure, Report, Status } from '../types/index.js';
import { localTier } from '../inference/types.js';
import { Logger } from '../utils/logger.js';

export interface DeepRunResult {
    failures: Failure[];
    summary: Status;
    stats: NonNullable<Report['stats']['deep']>;
}

/**
 * Run the deep gate and turn its outcome into summary, stats and failures.
 * A deep run that could not analyze anything is ERROR with a visible
 * failure, never a clean PASS.
 */
export async function runDeepAnalysis(
    config: Config,
    context: Pick<GateContext, 'cwd' | 'ignore' | 'patterns'>,
    deepOptions: DeepOptions & { onProgress?: (msg: string) => void },
): Promise<DeepRunResult> {
    const start = Date.now();
    const deepGate = new DeepAnalysisGate({
        options: deepOptions,
        checks: config.gates.deep?.checks,
        threads: config.gates.deep?.threads,
        maxTokens: config.gates.deep?.max_tokens,
        temperature: config.gates.deep?.temperature,
        timeoutMs: config.gates.deep?.timeout_ms,
        intentChecks: config.gates.deep?.intent_checks,
        onProgress: deepOptions.onProgress,
    });

    let findings: Failure[] = [];
    let thrown: string | undefined;
    try {
        findings = await deepGate.run(context);
    } catch (error: any) {
        thrown = error?.message ?? String(error);
        Logger.error(`Deep analysis failed: ${thrown}`);
    }
    // A gate that threw produced nothing: never report its last outcome as ok.
    const outcome = thrown ? { ...deepGate.getOutcome(), status: 'error' as const, error: thrown } : deepGate.getOutcome();
    const isLocal = !deepOptions.apiKey || (deepOptions.provider || '').toLowerCase() === 'local';

    const stats: NonNullable<Report['stats']['deep']> = {
        enabled: true,
        status: outcome.status,
        mode: outcome.mode,
        tier: isLocal ? localTier(deepOptions) : 'cloud',
        model: outcome.model,
        model_fallback: outcome.modelFallback,
        total_ms: Date.now() - start,
        files_analyzed: outcome.filesAnalyzed,
        chunks_total: outcome.chunksTotal,
        chunks_failed: outcome.chunksFailed,
        error: outcome.error,
        findings_proposed: outcome.findingsProposed,
        findings_withdrawn: outcome.findingsWithdrawn,
        findings_count: findings.length,
        findings_verified: findings.filter(f => f.verified).length,
    };

    if (outcome.status === 'error') {
        return {
            failures: [{
                id: 'deep-analysis',
                title: 'Deep analysis did not run',
                details: outcome.error || 'Deep analysis failed before producing results.',
                severity: 'medium',
                provenance: 'traditional',
                hint: 'Run `rigour doctor`. For local mode, `rigour deep pull` installs the engine and model.',
            }],
            summary: 'ERROR',
            stats,
        };
    }
    return { failures: findings, summary: findings.length > 0 ? 'FAIL' : 'PASS', stats };
}
