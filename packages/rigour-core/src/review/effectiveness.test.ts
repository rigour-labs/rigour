import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { appendAgentEvent, computeEffectiveness, readAgentEvents, type AgentEvent } from './effectiveness.js';

const review = (failures: Array<{ id: string; file: string }>): AgentEvent[] => [
    { type: 'tool_call', tool: 'rigour_review' },
    { type: 'tool_response', tool: 'rigour_review', content: [{ type: 'text', text: JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', failures }) }] },
];

describe('computeEffectiveness', () => {
    it('counts reviews, findings resolved by later reviews, and tool calls', () => {
        const events = [
            { type: 'tool_call', tool: 'rigour_recall' },
            ...review([{ id: 'semantic-bugs', file: 'a.ts' }, { id: 'promise-safety', file: 'b.ts' }]),
            ...review([{ id: 'promise-safety', file: 'b.ts' }]),
            ...review([]),
        ];
        expect(computeEffectiveness(events)).toMatchObject({
            reviews: 3, failedReviews: 2, findingsReported: 2, findingsResolved: 2,
            toolCalls: { rigour_recall: 1, rigour_review: 3 },
        });
    });

    it('follows a blocked stop through to a clean stop in the same session, and counts self-reviews', () => {
        const events: AgentEvent[] = [
            { type: 'stop_review', session: 's1', blocked: true },
            ...review([]),
            { type: 'stop_review', session: 's1', blocked: false },
            { type: 'stop_review', session: 's2', blocked: false },
        ];
        expect(computeEffectiveness(events)).toMatchObject({
            stopChecks: 3, stopBlocks: 1, blockedStopsFollowedThrough: 1, stopsWithSelfReview: 1,
        });
    });

    it('reads the log it writes and skips malformed lines', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effectiveness-'));
        appendAgentEvent(dir, { type: 'stop_review', blocked: true });
        fs.appendFileSync(path.join(dir, '.rigour', 'events.jsonl'), 'not json\n');
        expect(readAgentEvents(dir).map(e => e.type)).toEqual(['stop_review']);
        expect(readAgentEvents(path.join(dir, 'missing'))).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
