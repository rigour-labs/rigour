import { describe, expect, it } from 'vitest';
import { buildMcpResultMeta, buildStudioImpact } from './impact-receipt.js';

const guidance = {
    kind: 'context-scope' as const,
    recommendation: 'Read only the two evidence-backed files.',
    selectedFiles: ['src/a.ts', 'src/b.ts'],
    excludedFileCount: 18,
};

const telemetry = {
    candidateTokens: 2400,
    returnedTokens: 400,
    candidateFiles: 20,
    returnedFiles: 2,
    cacheStatus: 'exact-hit' as const,
    isEstimated: true,
};

describe('impact receipt projections', () => {
    it('preserves existing MCP metadata and adds measured impact', () => {
        expect(buildMcpResultMeta({ vendor: 'kept' }, 'request-1', 'ui://rigour', guidance, telemetry)).toMatchObject({
            vendor: 'kept',
            ui: { resourceUri: 'ui://rigour' },
            rigourImpact: {
                requestId: 'request-1',
                classification: 'measured estimate',
                context: { avoidedTokens: 2000, excludedFiles: 18 },
            },
        });
    });

    it('projects only safe guidance and counters into Studio events', () => {
        expect(buildStudioImpact(guidance, telemetry)).toEqual({
            guidance,
            telemetry: {
                candidateTokens: 2400,
                returnedTokens: 400,
                candidateFiles: 20,
                returnedFiles: 2,
                cacheStatus: 'exact-hit',
                classification: 'measured estimate',
            },
        });
    });
});
