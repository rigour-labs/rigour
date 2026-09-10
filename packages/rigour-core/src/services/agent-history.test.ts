import { describe, expect, it } from 'vitest';
import { buildAgentRuns, normalizeAgentEvent, normalizeAgentEvents } from './agent-history.js';

describe('agent history', () => {
    it('normalizes incomplete historical records without dropping them', () => {
        const event = normalizeAgentEvent({ type: 'tool_error', arguments: { files: ['src/a.ts'] } });
        expect(event.agentId).toBe('unknown-agent');
        expect(event.outcome).toBe('error');
        expect(event.files).toEqual(['src/a.ts']);
    });

    it('groups events into stable runs and retains outcomes', () => {
        const events = [
            normalizeAgentEvent({ id: '1', sessionId: 's1', agentId: 'a1', timestamp: '2026-01-01T00:00:00Z', tool: 'read' }),
            normalizeAgentEvent({ id: '2', sessionId: 's1', agentId: 'a1', timestamp: '2026-01-01T00:01:00Z', type: 'completed', files: ['src/a.ts'] }),
        ];
        expect(buildAgentRuns(events)).toMatchObject([{ id: 's1', eventCount: 2, status: 'success', files: ['src/a.ts'] }]);
    });

    it('normalizes guidance safely and builds an honest impact receipt', () => {
        const events = [normalizeAgentEvent({
            id: 'response-1', requestId: 'request-1', agentId: 'agent-1', timestamp: '2026-01-01T00:00:00Z',
            type: 'tool_response', status: 'success',
            guidance: {
                kind: 'context-scope',
                recommendation: 'Read only the two evidence-backed files.',
                patternRefs: [{ id: 'p1', label: 'withTransaction' }, { bad: true }],
                lessonRefs: [{ id: 'l1', label: 'Bound retries' }],
                selectedFiles: ['src/a.ts', 42],
                excludedFileCount: 18,
            },
            telemetry: {
                candidateTokens: 2400,
                returnedTokens: 400,
                candidateFiles: 20,
                returnedFiles: 2,
                cacheStatus: 'exact-hit',
                classification: 'measured estimate',
            },
        })];

        expect(events[0].guidance?.selectedFiles).toEqual(['src/a.ts']);
        expect(buildAgentRuns(events)[0].impact).toMatchObject({
            guidanceCount: 1,
            knowledgeItems: 2,
            avoidedTokens: 2000,
            excludedFiles: 18,
            cacheHits: 1,
        });
    });

    it('ignores malformed guidance rather than breaking legacy history', () => {
        const event = normalizeAgentEvent({ guidance: { kind: 'context-scope', recommendation: 42 }, telemetry: 'bad' });
        expect(event.guidance).toBeUndefined();
        expect(event.telemetry).toBeUndefined();
    });
});

describe('normalizeAgentEvents', () => {
    it('carries request identity into the matching response', () => {
        const events = normalizeAgentEvents([
            {
                type: 'tool_call', requestId: 'request-1', tool: 'rigour_checkpoint',
                timestamp: '2026-09-10T00:00:00Z',
                arguments: { agentId: 'agent-a', taskId: 'task-a', filesChanged: ['src/a.ts'] },
            },
            {
                type: 'tool_response', requestId: 'request-1', tool: 'rigour_checkpoint', status: 'success',
                timestamp: '2026-09-10T00:00:01Z',
            },
        ]);

        expect(events[1]).toMatchObject({ agentId: 'agent-a', taskId: 'task-a', files: ['src/a.ts'] });
        expect(buildAgentRuns(events)).toHaveLength(1);
    });
});
