import Graph from 'graphology';
import type { GraphData, GraphNode, GraphNodeType, GraphPerspective } from './types';

export const NODE_COLORS: Record<GraphNodeType, string> = {
    repository: '#22d3ee',
    file: '#64748b',
    agent: '#a78bfa',
    task: '#60a5fa',
    run: '#f59e0b',
    gateway: '#22d3ee',
    action: '#fb923c',
    capability: '#c084fc',
    advice: '#2dd4bf',
    pattern: '#f472b6',
    memory: '#38bdf8',
    lesson: '#34d399',
    policy: '#fbbf24',
    outcome: '#fb7185',
};

const PERSPECTIVE_TYPES: Record<GraphPerspective, Set<GraphNodeType>> = {
    impact: new Set(['repository', 'agent', 'task', 'run', 'gateway', 'action', 'capability', 'advice', 'lesson', 'policy', 'outcome']),
    code: new Set(['repository', 'file', 'pattern']),
    knowledge: new Set(['repository', 'gateway', 'action', 'capability', 'advice', 'pattern', 'memory', 'lesson', 'policy', 'outcome']),
    all: new Set(Object.keys(NODE_COLORS) as GraphNodeType[]),
};

function initialPosition(index: number, count: number, type: GraphNodeType): { x: number; y: number } {
    const types = Object.keys(NODE_COLORS) as GraphNodeType[];
    const typeIndex = types.indexOf(type);
    const clusterAngle = (typeIndex / types.length) * Math.PI * 2;
    const nodeAngle = clusterAngle + ((index % 17) / 17 - 0.5) * 0.7;
    const radius = 6 + (index / Math.max(1, count)) * 4;
    return { x: Math.cos(nodeAngle) * radius, y: Math.sin(nodeAngle) * radius };
}

function matchesQuery(node: GraphNode, query: string): boolean {
    return `${node.label} ${node.detail ?? ''} ${node.state ?? ''}`.toLowerCase().includes(query);
}

export function selectGraphData(data: GraphData, perspective: GraphPerspective, query: string): GraphData {
    const allowed = PERSPECTIVE_TYPES[perspective];
    const candidates = data.nodes.filter(node => allowed.has(node.type));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return { ...data, nodes: candidates };

    const matched = new Set(candidates.filter(node => matchesQuery(node, normalized)).map(node => node.id));
    const visible = new Set(matched);
    for (const edge of data.edges) {
        if (matched.has(edge.from)) visible.add(edge.to);
        if (matched.has(edge.to)) visible.add(edge.from);
    }
    return { ...data, nodes: candidates.filter(node => visible.has(node.id)) };
}

export function createSigmaGraph(data: GraphData): Graph {
    const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: false });
    const ids = new Set(data.nodes.map(node => node.id));
    data.nodes.forEach((node, index) => {
        const point = initialPosition(index, data.nodes.length, node.type);
        const { type: entityType, ...attributes } = node;
        graph.addNode(node.id, {
            ...attributes,
            entityType,
            ...point,
            size: Math.max(2.5, Math.min(13, 2 + Math.sqrt(Math.max(1, node.weight)) * 1.8)),
            color: NODE_COLORS[node.type],
            label: node.label,
        });
    });
    data.edges.forEach(edge => {
        if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) return;
        graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, {
            kind: edge.type,
            color: edge.type === 'imports' ? 'rgba(34, 211, 238, 0.18)' : 'rgba(148, 163, 184, 0.34)',
            size: edge.type === 'imports' ? 0.4 : 0.8,
        });
    });
    return graph;
}

export function graphNeighbours(data: GraphData, nodeId: string): GraphNode[] {
    const ids = new Set<string>();
    data.edges.forEach(edge => {
        if (edge.from === nodeId) ids.add(edge.to);
        if (edge.to === nodeId) ids.add(edge.from);
    });
    return data.nodes.filter(node => ids.has(node.id));
}
