import { describe, expect, it } from 'vitest';
import { affectedDependents } from './dependency-graph.js';

describe('affectedDependents', () => {
    it('includes direct and transitive consumers', () => {
        const affected = affectedDependents({
            version: 1,
            generatedAt: '2026-09-10T00:00:00Z',
            nodes: ['a.ts', 'b.ts', 'c.ts'],
            edges: [{ from: 'b.ts', to: 'a.ts' }, { from: 'c.ts', to: 'b.ts' }],
        }, ['a.ts']);

        expect(new Set(affected)).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
    });
});
