import type { GuidanceMeta, TelemetryMeta } from './context-telemetry.js';

function classification(telemetry?: TelemetryMeta): 'observed' | 'measured estimate' {
    return telemetry?.isEstimated ? 'measured estimate' : 'observed';
}

export function buildStudioImpact(guidance?: GuidanceMeta, telemetry?: TelemetryMeta) {
    return {
        guidance,
        telemetry: telemetry ? {
            candidateTokens: telemetry.candidateTokens,
            returnedTokens: telemetry.returnedTokens,
            candidateFiles: telemetry.candidateFiles,
            returnedFiles: telemetry.returnedFiles,
            cacheStatus: telemetry.cacheStatus,
            classification: classification(telemetry),
        } : undefined,
    };
}

export function buildMcpResultMeta(
    existingMeta: unknown,
    requestId: string,
    resourceUri: string,
    guidance?: GuidanceMeta,
    telemetry?: TelemetryMeta,
): Record<string, unknown> {
    const base = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
        ? existingMeta as Record<string, unknown>
        : {};
    if (!guidance) return { ...base, ui: { resourceUri } };

    return {
        ...base,
        ui: { resourceUri },
        rigourImpact: {
            requestId,
            classification: classification(telemetry),
            guidance,
            context: telemetry ? {
                candidateTokens: telemetry.candidateTokens,
                returnedTokens: telemetry.returnedTokens,
                avoidedTokens: Math.max(0, telemetry.candidateTokens - telemetry.returnedTokens),
                candidateFiles: telemetry.candidateFiles,
                returnedFiles: telemetry.returnedFiles,
                excludedFiles: typeof telemetry.candidateFiles === 'number' && typeof telemetry.returnedFiles === 'number'
                    ? Math.max(0, telemetry.candidateFiles - telemetry.returnedFiles)
                    : undefined,
                cacheStatus: telemetry.cacheStatus,
            } : undefined,
        },
    };
}
