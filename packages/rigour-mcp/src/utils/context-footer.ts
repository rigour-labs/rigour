/**
 * Closed-loop context efficiency footers appended to MCP tool responses.
 */
import type { TelemetryMeta } from './context-telemetry.js';

export function formatContextFooter(meta: TelemetryMeta, nextStep?: string): string {
    const saved = Math.max(0, meta.candidateTokens - meta.returnedTokens);
    let footer = `\n\n[Rigour Context] cache=${meta.cacheStatus}`;
    if (saved > 0) {
        footer += ` | saved~${saved.toLocaleString()} tokens`;
    }
    if (meta.deduplicatedTokens && meta.deduplicatedTokens > 0) {
        footer += ` | dedup~${meta.deduplicatedTokens.toLocaleString()} tokens`;
    }
    if (nextStep) {
        footer += ` | Next: ${nextStep}`;
    }
    return footer;
}

export function appendContextFooter(
    text: string,
    meta: TelemetryMeta | undefined,
    nextStep?: string,
): string {
    if (!meta) return text;
    return text + formatContextFooter(meta, nextStep);
}
