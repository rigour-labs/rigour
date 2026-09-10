import { describe, expect, it } from 'vitest';
import { createSigmaGraph, graphNeighbours, selectGraphData } from './graph-model';
import type { GraphData } from './types';

const data: GraphData = {
    schemaVersion: 1,
    generatedAt: '2026-09-10T00:00:00.000Z',
    truncated: false,
    counts: { repository: 1, file: 1, agent: 1, lesson: 1 },
    nodes: [
        { id: 'repo', type: 'repository', label: 'payments', weight: 10 },
        { id: 'file', type: 'file', label: 'checkout.ts', weight: 3 },
        { id: 'agent', type: 'agent', label: 'atlas', weight: 5 },
        { id: 'lesson', type: 'lesson', label: 'bounded retry', weight: 4 },
    ],
    edges: [
        { id: 'contains', from: 'repo', to: 'file', type: 'contains' },
        { id: 'performed', from: 'agent', to: 'repo', type: 'performed' },
        { id: 'learned', from: 'repo', to: 'lesson', type: 'produced' },
    ],
};

describe('Studio graph model', () => {
    it('filters perspectives without losing the source data', () => {
        const impact = selectGraphData(data, 'impact', '');
        expect(impact.nodes.map(node => node.type)).toEqual(['repository', 'agent', 'lesson']);
        expect(data.nodes).toHaveLength(4);
    });

    it('keeps one-hop context around a search result', () => {
        const result = selectGraphData(data, 'all', 'checkout');
        expect(result.nodes.map(node => node.id)).toEqual(['repo', 'file']);
    });

    it('creates a renderable graph and reports neighbours', () => {
        const graph = createSigmaGraph(data);
        expect(graph.order).toBe(4);
        expect(graph.size).toBe(3);
        expect(graph.getNodeAttribute('repo', 'type')).toBeUndefined();
        expect(graph.getNodeAttribute('repo', 'entityType')).toBe('repository');
        expect(graphNeighbours(data, 'repo')).toHaveLength(3);
    });
});
