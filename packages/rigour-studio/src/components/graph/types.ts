export type GraphPerspective = 'impact' | 'code' | 'knowledge' | 'all';

export type GraphNodeType =
    | 'repository'
    | 'file'
    | 'agent'
    | 'task'
    | 'run'
    | 'gateway'
    | 'action'
    | 'capability'
    | 'advice'
    | 'pattern'
    | 'memory'
    | 'lesson'
    | 'policy'
    | 'outcome';

export interface GraphNode {
    id: string;
    type: GraphNodeType;
    label: string;
    detail?: string;
    state?: string;
    weight: number;
    repositoryId?: string;
    evidence?: Record<string, unknown>;
}

export interface GraphEdge {
    id: string;
    from: string;
    to: string;
    type: string;
}

export interface GraphData {
    schemaVersion: 1;
    nodes: GraphNode[];
    edges: GraphEdge[];
    counts: Record<string, number>;
    truncated: boolean;
    generatedAt?: string;
    error?: string;
}

export interface GraphSelection {
    node: GraphNode;
    relationshipCount: number;
    neighbours: GraphNode[];
}
